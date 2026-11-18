"""The one database view, (re)created at app startup.

gaze_readable unpacks the gaze table (50 samples per row) into one row per
gaze sample:

- page: the page in plain English (Question 54). The short page id (q54)
  is left out; it is the start of element_id, and pages.page also matches.
- element_id: the exact labelled part of the page under the gaze point, as
  saved (q54-b-text); block is the same in plain English (answer b). The
  functions behind both are in readable.py.
- word: the nearest word to the point (in the same text, or within 60 px
  elsewhere; see eyetracker.js nearestWord),
  as text, e.g. "dog". line is the line of its block that word is on, read
  from the word's id (q95-a-l1-w2 = question 95, answer a, line 1).
- word_distance_px: how far the point was from that word (0 = right on it).
  WebGazer is often off by 100 px or more, so filter on this to keep only
  close matches.

Rows saved before the word columns existed have no word or distance; their line comes from element_id when the point was
right on a word.
"""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# The columns changed, which CREATE OR REPLACE can't do, so drop it first.
DROP_GAZE_READABLE_SQL = "DROP VIEW IF EXISTS gaze_readable"

GAZE_READABLE_SQL = """
CREATE VIEW gaze_readable AS
SELECT
    g.session_id,
    g.participant_name,
    round(u.seconds::numeric, 2) AS seconds_from_start,
    gaze_page_label(u.page_id) AS page,
    u.x,
    u.y,
    u.element_id,
    gaze_area(u.page_id, u.element_id) AS block,
    u.word_text AS word,
    round(u.word_distance::numeric) AS word_distance_px,
    (regexp_match(coalesce(u.word_id, u.element_id), '-l([0-9]+)-w[0-9]+$'))[1]::int AS line
FROM gaze g
CROSS JOIN LATERAL unnest(
    g.seconds_from_start, g.x_values, g.y_values, g.page_ids, g.element_ids,
    g.word_ids, g.word_texts, g.word_distances
) AS u(seconds, x, y, page_id, element_id, word_id, word_text, word_distance)
"""


async def create_views(conn: AsyncConnection) -> None:
    await conn.execute(text(DROP_GAZE_READABLE_SQL))
    await conn.execute(text(GAZE_READABLE_SQL))
