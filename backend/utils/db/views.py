"""SQL views for reading packed gazepoint_data as one row per raw sample.

gazepoint_data stores up to GAZE_BATCH_SIZE samples per row as parallel
arrays. gazepoint_data_flat unnests those arrays back into individual rows
(same shape as the old, pre-batching table) so ad-hoc inspection in pgAdmin
and existing per-sample readers don't need to know about the packing.
"""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

CREATE_FLAT_VIEW_SQL = text(
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
        b.created_at
    FROM gazepoint_data b
    CROSS JOIN LATERAL unnest(b.x_values, b.y_values, b.timestamps, b.html_element_ids)
        WITH ORDINALITY AS u(x, y, ts, html_element_id, ord)
    """
)


async def create_flat_view(conn: AsyncConnection) -> None:
    await conn.execute(CREATE_FLAT_VIEW_SQL)
