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
    """Create all tables if they do not yet exist (called at app startup)."""
    from . import models  # noqa: F401 - ensure models register with Base.metadata

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
