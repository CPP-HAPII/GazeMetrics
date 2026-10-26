"""Copy data from the old tables into the new ones, once, at app startup.

Before October 2026 the data lived in gazepoint_sessions, gazepoint_data,
page_visits, answer_events, validation_points and fixation_points. The new
tables (see models.py) hold the same information in fewer tables. When the
old tables exist and the new sessions table is still empty, everything is
copied across, keeping the session ids. The old tables are left untouched;
drop them by hand once the copy has been checked (README: "Removing the old
tables").
"""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# Old answer_events / validation_points tables may not exist in every
# database (they were added later), so each step names the tables it needs.
STEPS = [
    (["gazepoint_sessions"], """
        INSERT INTO sessions (id, participant_name, test_name, started_at, browser_width, browser_height)
        SELECT id, participant_name, page_name, created_at, browser_width, browser_height
        FROM gazepoint_sessions
    """),
    (["gazepoint_sessions"], """
        SELECT setval(pg_get_serial_sequence('sessions', 'id'),
                      greatest((SELECT max(id) FROM sessions), 1))
    """),
    # Old gaze rows have no page per sample; those stay empty.
    (["gazepoint_data"], """
        INSERT INTO gaze (session_id, participant_name, sample_count, seconds_from_start,
                          x_values, y_values, page_ids, element_ids, created_at)
        SELECT d.session_id, s.participant_name, d.sample_count, d.timestamps,
               d.x_values, d.y_values, array_fill(NULL::varchar, ARRAY[d.sample_count]),
               d.html_element_ids, d.created_at
        FROM gazepoint_data d JOIN sessions s ON s.id = d.session_id
        ORDER BY d.id
    """),
    (["page_visits"], """
        INSERT INTO pages (session_id, participant_name, page_order, page_id, page_type,
                           started_at, seconds_from_start, seconds_on_page)
        SELECT v.session_id, s.participant_name, v.visit_index, v.page_id,
               CASE
                   WHEN v.page_id LIKE '%directions%' THEN 'directions'
                   WHEN v.page_id ~ '^passage-[0-9]+$' THEN 'reading'
                   WHEN v.page_id ~ '^q([1-9]|1[0-9]|20)$' THEN 'audio'
                   ELSE 'text'
               END,
               v.entered_at, v.entered_elapsed, v.duration_seconds
        FROM page_visits v JOIN sessions s ON s.id = v.session_id
        ORDER BY v.id
    """),
    (["page_visits", "answer_events"], """
        UPDATE pages p
        SET answer = a.last_choice,
            answer_text = a.last_text,
            answered_at_seconds = a.last_seconds,
            answer_history = a.history
        FROM (
            SELECT session_id, question_id,
                   (array_agg(choice ORDER BY selected_at DESC))[1] AS last_choice,
                   (array_agg(choice_text ORDER BY selected_at DESC))[1] AS last_text,
                   (array_agg(round(elapsed_seconds::numeric, 2) ORDER BY selected_at DESC))[1] AS last_seconds,
                   jsonb_agg(jsonb_build_object('answer', choice,
                                                'seconds', round(elapsed_seconds::numeric, 2))
                             ORDER BY selected_at) AS history
            FROM answer_events
            GROUP BY session_id, question_id
        ) a
        WHERE p.session_id = a.session_id AND p.page_id = a.question_id
    """),
    (["validation_points"], """
        INSERT INTO calibration (session_id, participant_name, attempt, checked_at,
                                 mean_error_px, points_with_data, points)
        SELECT v.session_id, s.participant_name, v.attempt, min(v.created_at),
               avg(v.mean_error_px), count(v.mean_error_px),
               jsonb_agg(jsonb_build_object('point', v.point_index, 'x', v.target_x, 'y', v.target_y,
                                            'error_px', round(v.mean_error_px::numeric, 1),
                                            'samples', v.sample_count)
                         ORDER BY v.point_index)
        FROM validation_points v JOIN sessions s ON s.id = v.session_id
        GROUP BY v.session_id, s.participant_name, v.attempt
    """),
    (["validation_points"], """
        UPDATE sessions s
        SET calibration_error_px = c.mean_error_px
        FROM (
            SELECT DISTINCT ON (session_id) session_id, mean_error_px
            FROM calibration ORDER BY session_id, attempt DESC
        ) c
        WHERE s.id = c.session_id
    """),
    (["fixation_points"], """
        INSERT INTO fixations (session_id, fixation_id, x, y, duration, timestamp)
        SELECT session_id, fixation_id, x, y, duration, timestamp
        FROM fixation_points ORDER BY id
    """),
]


async def _exists(conn: AsyncConnection, table: str) -> bool:
    return (await conn.execute(text("SELECT to_regclass(:t) IS NOT NULL"), {"t": table})).scalar()


async def migrate_old_tables(conn: AsyncConnection) -> None:
    if not await _exists(conn, "gazepoint_sessions"):
        return
    if (await conn.execute(text("SELECT count(*) FROM sessions"))).scalar():
        return   # already copied (or new data has arrived): never copy twice
    for tables, sql in STEPS:
        if all([await _exists(conn, t) for t in tables]):
            await conn.execute(text(sql))
