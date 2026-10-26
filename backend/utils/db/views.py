"""SQL views: readable versions of the stored data, (re)created at app startup.

The tables keep the raw data in the form that is efficient to write (gaze
samples packed 50 to a row, long element ids, times in seconds since
recording started). These views present it ready to read in Supabase or
pgAdmin, one row per thing:

  gazepoint_data_flat  one row per gaze sample (raw columns)
  gaze_samples         one row per gaze sample, with the page on screen and
                       the element id split into block / line / word
  final_answers        one row per answered question: the answer the
                       participant ended with, when, and after how many clicks
  calibration_summary  one row per accuracy check: average error over its points
  session_summary      one row per session: who, when, and how much was recorded

CREATE OR REPLACE VIEW can only add columns at the end of an existing view,
so add new columns last (or drop the view first).
"""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# Pacific time, for the *_local columns (the lab is in California).
LOCAL_TZ = "America/Los_Angeles"

VIEWS = [
    # gazepoint_data stores up to GAZE_BATCH_SIZE samples per row as parallel
    # arrays; this unnests them back into individual rows.
    """
    CREATE OR REPLACE VIEW gazepoint_data_flat AS
    SELECT
        (b.id::bigint * 1000 + u.ord) AS id,
        b.id AS batch_id,
        b.session_id,
        b.user_id,
        u.x,
        u.y,
        u.ts AS timestamp,
        u.html_element_id,
        b.created_at,
        -- Looked up from the session rather than stored on every sample.
        s.participant_name
    FROM gazepoint_data b
    JOIN gazepoint_sessions s ON s.id = b.session_id
    CROSS JOIN LATERAL unnest(b.x_values, b.y_values, b.timestamps, b.html_element_ids)
        WITH ORDINALITY AS u(x, y, ts, html_element_id, ord)
    """,
    # Element ids look like q95-a-l1-w2 (block q95-a, line 1, word 2) or
    # q95-play (a block with no words); see exam.js.
    """
    CREATE OR REPLACE VIEW gaze_samples AS
    SELECT
        f.session_id,
        f.participant_name,
        round(f.timestamp::numeric, 2) AS seconds_since_start,
        pv.page_id,
        f.x,
        f.y,
        f.html_element_id AS element_id,
        regexp_replace(f.html_element_id, '-l[0-9]+-w[0-9]+$', '') AS block,
        (regexp_match(f.html_element_id, '-l([0-9]+)-w[0-9]+$'))[1]::int AS line,
        (regexp_match(f.html_element_id, '-w([0-9]+)$'))[1]::int AS word,
        f.id AS sample_id
    FROM gazepoint_data_flat f
    LEFT JOIN LATERAL (
        SELECT v.page_id
        FROM page_visits v
        WHERE v.session_id = f.session_id AND v.entered_elapsed <= f.timestamp
        ORDER BY v.entered_elapsed DESC
        LIMIT 1
    ) pv ON true
    """,
    f"""
    CREATE OR REPLACE VIEW final_answers AS
    SELECT
        last.session_id,
        s.participant_name,
        last.question_id,
        last.choice AS answer,
        last.choice_text AS answer_text,
        round(last.elapsed_seconds::numeric, 2) AS answered_at_seconds,
        last.selected_at AT TIME ZONE '{LOCAL_TZ}' AS answered_at_local,
        last.clicks AS times_selected,
        (SELECT round(sum(v.duration_seconds)::numeric, 1) FROM page_visits v
          WHERE v.session_id = last.session_id AND v.page_id = last.question_id) AS seconds_on_question
    FROM (
        SELECT DISTINCT ON (a.session_id, a.question_id)
            a.*,
            count(*) OVER (PARTITION BY a.session_id, a.question_id) AS clicks
        FROM answer_events a
        ORDER BY a.session_id, a.question_id, a.selected_at DESC, a.id DESC
    ) last
    JOIN gazepoint_sessions s ON s.id = last.session_id
    """,
    """
    CREATE OR REPLACE VIEW calibration_summary AS
    SELECT
        session_id,
        attempt,
        round(avg(mean_error_px)::numeric, 1) AS mean_error_px,
        count(*) AS points,
        count(mean_error_px) AS points_with_data,
        min(created_at) AS checked_at
    FROM validation_points
    GROUP BY session_id, attempt
    """,
    f"""
    CREATE OR REPLACE VIEW session_summary AS
    SELECT
        s.id AS session_id,
        s.participant_name,
        s.created_at AT TIME ZONE '{LOCAL_TZ}' AS started_local,
        s.browser_width,
        s.browser_height,
        (SELECT coalesce(sum(d.sample_count), 0) FROM gazepoint_data d
          WHERE d.session_id = s.id) AS gaze_samples,
        (SELECT count(*) FROM page_visits v WHERE v.session_id = s.id) AS pages_seen,
        (SELECT count(DISTINCT a.question_id) FROM answer_events a
          WHERE a.session_id = s.id) AS questions_answered,
        (SELECT round(sum(v.duration_seconds)::numeric / 60, 1) FROM page_visits v
          WHERE v.session_id = s.id) AS minutes_recorded,
        -- The last accuracy check is the calibration the recording used.
        (SELECT c.mean_error_px FROM calibration_summary c
          WHERE c.session_id = s.id ORDER BY c.attempt DESC LIMIT 1) AS calibration_error_px
    FROM gazepoint_sessions s
    """,
]


async def create_views(conn: AsyncConnection) -> None:
    for sql in VIEWS:
        await conn.execute(text(sql))


async def create_flat_view(conn: AsyncConnection) -> None:
    """Only gazepoint_data_flat; used by the one-off migration script."""
    await conn.execute(text(VIEWS[0]))
