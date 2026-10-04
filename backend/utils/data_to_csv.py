import asyncio
import sys
from pathlib import Path
import pandas as pd
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from db.database import get_db

BASE_DIR = Path(__file__).parent
DATA_PATH = BASE_DIR / "raw_WG_data"

async def get_data_by_session(session_id: int, db: AsyncSession) -> list[dict]:
    """Read raw samples via gazepoint_data_flat, which unnests the packed
    gazepoint_data rows back into one row per sample."""
    result = await db.execute(
        text(
            "SELECT x, y, timestamp FROM gazepoint_data_flat "
            "WHERE session_id = :session_id ORDER BY timestamp"
        ),
        {"session_id": session_id},
    )
    return [dict(row) for row in result.mappings().all()]

async def create_csv_from_data(session_id: int, data: list[dict]):
    csv_path = DATA_PATH / f"session_{session_id}_data.csv"

    df = pd.DataFrame(data)
    df.rename(columns={"timestamp": "TIME"}, inplace=True)
    df["TIMETICK"] = (df["TIME"] * 10_000_000).astype(int)

    df = df[["x", "y", "TIME", "TIMETICK"]]
    df.to_csv(csv_path, index=False)

async def main():
    try:
        async for db in get_db():
            SESSION_ID = int(sys.argv[1])
            gaze_data = await get_data_by_session(SESSION_ID, db)
            await create_csv_from_data(SESSION_ID, gaze_data)
    except Exception as e:
        print(f"Fatal DB error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
