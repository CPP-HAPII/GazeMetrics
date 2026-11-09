"""Async PostgreSQL database layer for the standalone eye-tracking demo.

Every pipeline script and the FastAPI app import `get_db` from here, so
switching the engine in this single file propagates the change everywhere.

Connection info comes from the `DATABASE_URL` environment variable (loaded
from a local `.env` file via python-dotenv), never hardcoded. See
`.env.example` in the backend root for the expected format.
"""
import os

from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import (
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.orm import DeclarativeBase

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Copy .env.example to .env and fill in your "
        "PostgreSQL connection string, e.g. "
        "postgresql+asyncpg://user:password@localhost:5432/gazemetrics"
    )

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    """Yield an async session, committing on success and rolling back on error."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db() -> None:
    """Create any missing tables, copy data over from the old tables the first
    time (see migrate_old_tables.py), and (re)create the gaze_readable view.
    Called at app startup."""
    from . import models  # noqa: F401 - ensure models register with Base.metadata
    from .views import create_views
    from .migrate_old_tables import migrate_old_tables

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await migrate_old_tables(conn)
        await add_answer_key_columns(conn)
        await create_views(conn)


async def add_answer_key_columns(conn) -> None:
    """Add pages.correct_answer / is_correct to databases created before they
    existed (create_all only makes missing tables, not missing columns), and
    mark every saved answer against the current key, so pages saved earlier,
    or under an older key, are brought up to date."""
    from sqlalchemy import bindparam, text
    from sqlalchemy.dialects.postgresql import JSONB
    from .answer_key import ANSWER_KEY

    await conn.execute(text(
        "ALTER TABLE pages ADD COLUMN IF NOT EXISTS correct_answer varchar(8), "
        "ADD COLUMN IF NOT EXISTS is_correct boolean"
    ))
    await conn.execute(
        text("""
            UPDATE pages p
            SET correct_answer = k.value,
                is_correct = coalesce(p.answer = k.value, false)
            FROM jsonb_each_text(:key) AS k
            WHERE p.page_id = k.key AND p.correct_answer IS DISTINCT FROM k.value
        """).bindparams(bindparam("key", type_=JSONB)),
        {"key": ANSWER_KEY},
    )
