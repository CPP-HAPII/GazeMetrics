"""Make the database easy to read for someone browsing it in Supabase.

- Two SQL functions turn the short ids saved by the test page into plain
  English: gaze_page_label('q54') = 'Question 54', and
  gaze_area('q54', 'q54-b-text') = 'answer b'. The gaze_readable view and
  the pages table both use them.
- pages gets a plain-English `page` column (update_page_labels), filled for
  every saved page at startup and for each new page as it is saved.
- Every table, the view and every column get a description (add_comments),
  which Supabase shows when you hover over a table or column name.
"""
from sqlalchemy import Integer, bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY

PAGE_LABEL_SQL = r"""
CREATE OR REPLACE FUNCTION gaze_page_label(page_id text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN page_id ~ '^q[0-9]+$'
      THEN 'Question ' || substr(page_id, 2)
    WHEN page_id ~ '^passage-[0-9]+$'
      THEN 'Reading passage ' || substr(page_id, 9)
    WHEN page_id ~ '^passage-[0-9]+-q[0-9]+$'
      THEN 'Reading passage ' || (regexp_match(page_id, '^passage-([0-9]+)'))[1]
           || ', question ' || (regexp_match(page_id, '-q([0-9]+)$'))[1]
    WHEN page_id ~ '^part-[0-9]+$'
      THEN 'Part ' || substr(page_id, 6) || ' title page'
    WHEN page_id = 'listening-directions' THEN 'Listening directions'
    WHEN page_id = 'reading-directions' THEN 'Reading directions'
    WHEN page_id ~ '^written-directions-[0-9]+$'
      THEN 'Grammar, vocabulary and reading directions, page ' || substr(page_id, 20)
    ELSE page_id
  END
$$
"""

# Element ids are the page id followed by the part of the page (see exam.js):
# q54-b-text is the text of answer b on question 54, q54-b-l1-w3 is word 3 on
# line 1 of that answer, passage-3-l2-w17 is a word of reading passage 3.
AREA_SQL = r"""
CREATE OR REPLACE FUNCTION gaze_area(page_id text, element_id text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  part text;
BEGIN
  IF element_id IS NULL OR element_id = 'contentFrame' THEN
    RETURN 'page margin';
  END IF;
  IF page_id IS NULL OR left(element_id, length(page_id)) <> page_id THEN
    RETURN element_id;
  END IF;
  IF element_id = page_id THEN
    RETURN 'empty space on the page';
  END IF;
  IF substr(element_id, length(page_id) + 1, 1) <> '-' THEN
    RETURN element_id;
  END IF;
  -- The part after the page id, without a word's line/word ending.
  part := regexp_replace(substr(element_id, length(page_id) + 2), '-?l[0-9]+-w[0-9]+$', '');
  RETURN CASE
    WHEN part ~ '^[a-d](-text|-input)?$' THEN 'answer ' || left(part, 1)
    WHEN part = 'options' THEN 'between answers'
    WHEN part IN ('', 'text', 'passage') THEN 'passage'
    WHEN part IN ('question', 'prompt') OR part ~ '^line[0-9]+$' THEN 'question'
    WHEN part = 'instructions' THEN 'instructions'
    WHEN part IN ('media', 'play') THEN 'audio player'
    WHEN part = 'title' THEN 'title'
    WHEN part = 'body' OR part ~ '^example[0-9]+$' THEN 'directions text'
    WHEN part = 'btn' THEN 'Next button'
    WHEN part = 'prev-btn' THEN 'Previous button'
    WHEN part = 'counter' THEN 'page counter'
    ELSE part
  END;
END
$$
"""

async def create_functions(conn) -> None:
    await conn.execute(text(PAGE_LABEL_SQL))
    await conn.execute(text(AREA_SQL))


async def add_page_columns(conn) -> None:
    """Add pages.page to a pages table created before it existed
    (create_all only makes missing tables, not missing columns)."""
    await conn.execute(text("ALTER TABLE pages ADD COLUMN IF NOT EXISTS page varchar(255)"))


async def update_page_labels(conn, session_ids=None) -> None:
    """Fill pages.page (Question 54) from page_id, for the given sessions
    (None = all). `conn` is a connection or session."""
    sessions = bindparam("sessions", value=session_ids, type_=ARRAY(Integer))
    await conn.execute(
        text("""
            UPDATE pages SET page = gaze_page_label(page_id)
            WHERE page IS DISTINCT FROM gaze_page_label(page_id)
              AND (CAST(:sessions AS int[]) IS NULL OR session_id = ANY(CAST(:sessions AS int[])))
        """).bindparams(sessions)
    )


# ---------------------------------------------------------------- comments

ID_NOTE = (
    "Page ids: q54 = question 54, passage-3 = reading passage 3, "
    "passage-3-q1 = its first question."
)

COMMENTS = {
    "sessions": (
        "One row per participant session. Start here to find a session_id.",
        {
            "id": "Session number; the session_id in every other table.",
            "participant_name": "The ID the participant typed on the welcome page.",
            "test_name": "Which test was taken, e.g. exam1.",
            "started_at": "When the session was created (UTC).",
            "browser_width": "Width of the participant's browser window, in pixels.",
            "browser_height": "Height of the participant's browser window, in pixels.",
            "calibration_error_px": "Average distance (pixels) between where the participant looked and where the tracker thought they looked, in the last accuracy check. Lower is better.",
        },
    ),
    "pages": (
        "One row per test page shown: how long it was on screen, the answer chosen and whether it was correct. The best table for an overview.",
        {
            "id": "Row number.",
            "session_id": "Which session (sessions.id).",
            "participant_name": "The participant's ID.",
            "page_order": "Order the page was shown in: 1 = first.",
            "page_id": "Short page id. " + ID_NOTE,
            "page": "The page in plain English, e.g. Question 54.",
            "page_type": "directions, audio (listening question), text (written question) or reading (reading passage).",
            "started_at": "When the page appeared (UTC).",
            "seconds_from_start": "When the page appeared, in seconds since the participant clicked Start recording.",
            "seconds_on_page": "How long the page was on screen, in seconds.",
            "answer": "The answer the participant ended with: a, b, c or d. Empty if none.",
            "answer_text": "The text of that answer.",
            "answered_at_seconds": "When that answer was clicked, in seconds since Start recording.",
            "answer_history": "Every answer clicked on the page, in order, with the time of each click (shows changed answers).",
            "correct_answer": "The correct answer from the answer key. Empty for pages without one.",
            "is_correct": "true if the answer matches the key; false if wrong or unanswered.",
        },
    ),
    "gaze_readable": (
        "Every gaze sample, one per row (10 per second): where the participant was looking, on which page, and at which part of it and which word. Use this, not the gaze table.",
        {
            "session_id": "Which session (sessions.id).",
            "participant_name": "The participant's ID.",
            "seconds_from_start": "When the sample was taken, in seconds since Start recording.",
            "page": "The page in plain English, e.g. Question 54.",
            "page_id": "Short page id, matching pages.page_id. " + ID_NOTE,
            "x": "Gaze position, pixels from the left of the browser window.",
            "y": "Gaze position, pixels from the top of the browser window.",
            "element_id": "The exact labelled part of the page under the gaze point (detailed id, e.g. q54-b-text = answer b's text). Empty when nothing labelled was there.",
            "block": "The part of the page in plain English: question, passage, answer a-d, between answers, instructions, audio player, Next button, page margin, ...",
            "word": "The word nearest to the gaze point, as text: inside an answer, question or passage, its nearest word; elsewhere, the nearest word within 60 pixels. Empty for sessions recorded before words were saved, for buttons and audio players, and when no word was that close.",
            "word_distance_px": "How far the gaze point was from that word, in pixels; 0 = right on it. The tracker is often 100 px or more off, so filter on this (e.g. 30 or less) to keep only close matches.",
            "line": "Which line of its passage, question or answer the word is on (1 = first line), as the text wrapped on the participant's screen.",
        },
    ),
    "calibration": (
        "One row per accuracy check after calibration. If the participant recalibrated, the highest attempt is the one the recording used.",
        {
            "id": "Row number.",
            "session_id": "Which session (sessions.id).",
            "participant_name": "The participant's ID.",
            "attempt": "1 = first accuracy check, 2 = after recalibrating once, ...",
            "checked_at": "When the check was done (UTC).",
            "mean_error_px": "Average distance (pixels) between the dot and where the tracker thought the participant looked. Lower is better.",
            "points_with_data": "How many of the 12 dots got a reading from the tracker.",
            "points": "Each dot: its position, the error there, and how many samples it got.",
        },
    ),
    "gaze": (
        "Raw storage: 50 gaze samples packed into each row to save space. Hard to read; open the gaze_readable view instead.",
        {},
    ),
    "fixations": (
        "Fixations (places the eyes rested) computed by the viewer's Process fixations button. Empty until that is run for a session.",
        {
            "session_id": "Which session (sessions.id).",
            "x": "Fixation position, pixels from the left.",
            "y": "Fixation position, pixels from the top.",
            "duration": "How long the fixation lasted, in milliseconds.",
            "timestamp": "When it started, in milliseconds.",
        },
    ),
}


def _quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


async def add_comments(conn) -> None:
    """Describe every table, the view and their columns. Skips any table or
    column that doesn't exist in this database."""
    existing = {
        (r[0], r[1])
        for r in (await conn.execute(text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema()"
        ))).all()
    }
    tables = {t for t, _ in existing}
    for table, (table_comment, columns) in COMMENTS.items():
        if table not in tables:
            continue
        kind = "VIEW" if table == "gaze_readable" else "TABLE"
        await conn.execute(text(f"COMMENT ON {kind} {table} IS {_quote(table_comment)}"))
        for column, comment in columns.items():
            if (table, column) in existing:
                await conn.execute(text(f"COMMENT ON COLUMN {table}.{column} IS {_quote(comment)}"))
