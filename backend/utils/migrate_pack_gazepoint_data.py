"""One-time migration: repack the old per-sample gazepoint_data table into
the new packed schema (GAZE_BATCH_SIZE samples per row), preserving every
existing sample.

Run once, from the backend/ directory:
    python utils/migrate_pack_gazepoint_data.py

Safe to re-run: it's a no-op once gazepoint_data already has the packed
schema (detected via the sample_count column).

Steps:
  1. Rename the existing gazepoint_data -> gazepoint_data_legacy (data is
     never dropped, just renamed).
  2. Create the new packed gazepoint_data table (and gazepoint_data_flat
     view) via the current ORM models.
  3. Read every legacy row, grouped by session and ordered by timestamp,
     and write it back out in chunks of GAZE_BATCH_SIZE as packed rows.

gazepoint_data_legacy is left in place afterwards so you can sanity-check
counts before dropping it yourself.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import text  # noqa: E402
from db.database import engine, AsyncSessionLocal, Base  # noqa: E402
from db.models import GazepointData, GAZE_BATCH_SIZE  # noqa: E402
from db.views import create_flat_view  # noqa: E402

LEGACY_TABLE = "gazepoint_data_legacy"


async def _table_exists(conn, table: str) -> bool:
    result = await conn.execute(
        text("SELECT 1 FROM information_schema.tables WHERE table_name = :table"),
        {"table": table},
    )
    return result.first() is not None


async def _table_has_column(conn, table: str, column: str) -> bool:
    result = await conn.execute(
        text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = :table AND column_name = :column"
        ),
        {"table": table, "column": column},
    )
    return result.first() is not None


async def migrate() -> None:
    async with engine.begin() as conn:
        gazepoint_exists = await _table_exists(conn, "gazepoint_data")
        already_packed = gazepoint_exists and await _table_has_column(
            conn, "gazepoint_data", "sample_count"
        )

        if already_packed:
            print("gazepoint_data already has the packed schema; nothing to migrate.")
            await create_flat_view(conn)
            return

        if not gazepoint_exists:
            print("No existing gazepoint_data table; creating the packed schema fresh.")
            await conn.run_sync(Base.metadata.create_all)
            await create_flat_view(conn)
            return

        if await _table_exists(conn, LEGACY_TABLE):
            raise RuntimeError(
                f"{LEGACY_TABLE} already exists but gazepoint_data is not packed. "
                "Resolve this manually (check whether a previous migration run "
                "was interrupted) before re-running."
            )

        print(f"Renaming gazepoint_data -> {LEGACY_TABLE} ...")
        await conn.execute(text(f"ALTER TABLE gazepoint_data RENAME TO {LEGACY_TABLE}"))

        # RENAME TABLE doesn't rename the table's indexes/constraints, so the
        # new gazepoint_data create_all below would collide on their old
        # names (e.g. ix_gazepoint_data_user_id). Rename them out of the way.
        index_names = (await conn.execute(
            text("SELECT indexname FROM pg_indexes WHERE tablename = :t"),
            {"t": LEGACY_TABLE},
        )).scalars().all()
        for name in index_names:
            await conn.execute(text(f'ALTER INDEX "{name}" RENAME TO "{name}_legacy"'))

        constraint_names = (await conn.execute(
            text("SELECT conname FROM pg_constraint WHERE conrelid = (:t)::regclass"),
            {"t": LEGACY_TABLE},
        )).scalars().all()
        for name in constraint_names:
            await conn.execute(
                text(f'ALTER TABLE {LEGACY_TABLE} RENAME CONSTRAINT "{name}" TO "{name}_legacy"')
            )

        print("Creating packed gazepoint_data table ...")
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as db:
        legacy_rows = (await db.execute(
            text(
                f"SELECT session_id, user_id, x, y, timestamp, html_element_id, created_at "
                f"FROM {LEGACY_TABLE} ORDER BY session_id, timestamp, id"
            )
        )).mappings().all()

    print(f"Repacking {len(legacy_rows)} legacy samples into batches of {GAZE_BATCH_SIZE} ...")

    by_session: dict[int, list] = {}
    for r in legacy_rows:
        by_session.setdefault(r["session_id"], []).append(r)

    batches = []
    for session_id, samples in by_session.items():
        for i in range(0, len(samples), GAZE_BATCH_SIZE):
            chunk = samples[i : i + GAZE_BATCH_SIZE]
            batches.append(
                GazepointData(
                    session_id=session_id,
                    user_id=chunk[0]["user_id"],
                    x_values=[s["x"] for s in chunk],
                    y_values=[s["y"] for s in chunk],
                    timestamps=[s["timestamp"] for s in chunk],
                    html_element_ids=[s["html_element_id"] for s in chunk],
                    sample_count=len(chunk),
                    created_at=chunk[0]["created_at"],
                )
            )

    async with AsyncSessionLocal() as db:
        db.add_all(batches)
        await db.commit()

    async with engine.begin() as conn:
        await create_flat_view(conn)

    print(f"Wrote {len(batches)} packed rows across {len(by_session)} session(s).")
    print(
        f"Legacy per-sample data is preserved in {LEGACY_TABLE}. Verify counts "
        f"match (e.g. compare SELECT count(*) FROM {LEGACY_TABLE} against "
        "SELECT count(*) FROM gazepoint_data_flat), then drop it yourself once "
        f"you're confident:\n  DROP TABLE {LEGACY_TABLE};"
    )


if __name__ == "__main__":
    asyncio.run(migrate())
