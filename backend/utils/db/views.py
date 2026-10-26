"""The one database view, (re)created at app startup.

gaze_readable unpacks the gaze table (50 samples per row) into one row per
gaze sample, and splits each element id into block / line / word: e.g.
q95-a-l1-w2 is block q95-a (question 95, answer a), line 1, word 2; q95-play
is a block with no words (see exam.js).
"""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

GAZE_READABLE_SQL = """
CREATE OR REPLACE VIEW gaze_readable AS
SELECT
    g.session_id,
    g.participant_name,
    round(u.seconds::numeric, 2) AS seconds_from_start,
    u.page_id,
    u.x,
    u.y,
    u.element_id,
    regexp_replace(u.element_id, '-l[0-9]+-w[0-9]+$', '') AS block,
    (regexp_match(u.element_id, '-l([0-9]+)-w[0-9]+$'))[1]::int AS line,
    (regexp_match(u.element_id, '-w([0-9]+)$'))[1]::int AS word
FROM gaze g
CROSS JOIN LATERAL unnest(g.seconds_from_start, g.x_values, g.y_values, g.page_ids, g.element_ids)
    AS u(seconds, x, y, page_id, element_id)
"""


async def create_views(conn: AsyncConnection) -> None:
    await conn.execute(text(GAZE_READABLE_SQL))
