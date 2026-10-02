"""Standalone eye-tracking demo backend.

A single FastAPI service that:
  * serves the static frontend (capture + viewer pages),
  * stores gaze sessions and raw gaze points in PostgreSQL,
  * runs the reused ST-DBSCAN fixation pipeline on demand,
  * returns raw points and processed fixations for heatmap rendering.

Run from this directory:  uvicorn main:app --reload --port 8000
Then open:                http://localhost:8000/
"""
import sys
import shutil
import asyncio
import subprocess
import uuid
from pathlib import Path
from datetime import datetime, timezone

BASE_DIR = Path(__file__).resolve().parent          # backend/
UTILS_DIR = BASE_DIR / "utils"
FRONTEND_DIR = BASE_DIR.parent / "frontend"

# Make the pipeline's `db` package importable the same way the subprocess
# scripts see it (their sys.path[0] is utils/, so they do `from db...`).
sys.path.insert(0, str(UTILS_DIR))

from fastapi import FastAPI, Depends, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from sqlalchemy import select, func, text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from db.database import get_db, init_db, AsyncSessionLocal  # noqa: E402
from db.models import (  # noqa: E402
    GazepointSession, GazepointData, Fixation, ValidationPoint, PageVisit, GAZE_BATCH_SIZE,
)

# Minimum gaze points needed for the clustering pipeline to find a knee/fixations.
MIN_POINTS_FOR_FIXATIONS = 40

# Gaze points are held here and flushed to Postgres as a single bulk insert on
# this interval, instead of writing on every incoming /api/points request.
POINT_FLUSH_INTERVAL_SECONDS = 5
_point_buffer: list[dict] = []
_buffer_lock = asyncio.Lock()
_session_user_cache: dict[int, uuid.UUID] = {}

# Folders the pipeline writes into; cleared before each processing run so only
# the requested session is processed.
PIPELINE_WORK_DIRS = [
    UTILS_DIR / "raw_WG_data",
    UTILS_DIR / "elbow_knee_values",
    UTILS_DIR / "best_params",
    UTILS_DIR / "fixations",
]

app = FastAPI(title="Eye-Tracking Analysis Demo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    """Create Postgres tables if they don't exist yet, and start the batch flusher."""
    await init_db()
    app.state.flush_task = asyncio.create_task(_flush_loop())


@app.on_event("shutdown")
async def _shutdown() -> None:
    """Stop the flusher and persist any points still sitting in the buffer."""
    app.state.flush_task.cancel()
    try:
        await app.state.flush_task
    except asyncio.CancelledError:
        pass
    await _flush_buffer()


async def _flush_loop() -> None:
    """Wake up every POINT_FLUSH_INTERVAL_SECONDS and persist buffered points."""
    while True:
        await asyncio.sleep(POINT_FLUSH_INTERVAL_SECONDS)
        await _flush_buffer()


def _pack_points(points: list[dict]) -> list[dict]:
    """Group buffered samples into chunks of GAZE_BATCH_SIZE per session,
    preserving arrival order, and reshape each chunk into the packed
    (x_values, y_values, timestamps, html_element_ids, sample_count) columns
    that one GazepointData row stores."""
    by_session: dict[int, list[dict]] = {}
    for p in points:
        by_session.setdefault(p["session_id"], []).append(p)

    batches = []
    for session_id, samples in by_session.items():
        for i in range(0, len(samples), GAZE_BATCH_SIZE):
            chunk = samples[i : i + GAZE_BATCH_SIZE]
            batches.append(
                dict(
                    session_id=session_id,
                    user_id=chunk[0]["user_id"],
                    x_values=[s["x"] for s in chunk],
                    y_values=[s["y"] for s in chunk],
                    timestamps=[s["timestamp"] for s in chunk],
                    html_element_ids=[s["html_element_id"] for s in chunk],
                    sample_count=len(chunk),
                )
            )
    return batches


async def _flush_buffer() -> None:
    """Write everything currently buffered to Postgres as one bulk insert,
    packing every GAZE_BATCH_SIZE samples per session into a single row."""
    global _point_buffer
    async with _buffer_lock:
        if not _point_buffer:
            return
        batch, _point_buffer = _point_buffer, []

    now = datetime.now(timezone.utc)
    rows = [GazepointData(**item, created_at=now) for item in _pack_points(batch)]
    async with AsyncSessionLocal() as db:
        db.add_all(rows)
        await db.commit()


async def _get_session_user_id(db: AsyncSession, session_id: int) -> uuid.UUID:
    """Resolve (and cache) the per-session participant UUID for a session_id."""
    if session_id in _session_user_cache:
        return _session_user_cache[session_id]
    session = await db.get(GazepointSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    _session_user_cache[session_id] = session.user_id
    return session.user_id


@app.get("/api/health")
async def health():
    """Cheap no-database ping, used by the frontend to wake a sleeping instance."""
    return {"status": "ok"}


# --------------------------------------------------------------------------
# Capture endpoints
# --------------------------------------------------------------------------

@app.post("/api/session")
async def create_session(request: Request, db: AsyncSession = Depends(get_db)):
    """Create a gaze session and return its id."""
    body = await request.json()
    participant_name = str(body.get("participant_name") or "").strip()[:255] or None
    session = GazepointSession(
        user_id=uuid.uuid4(),
        participant_name=participant_name,
        page_name=body.get("page_name", "NA"),
        browser_width=int(body.get("browser_width") or 0),
        browser_height=int(body.get("browser_height") or 0),
        created_at=datetime.now(timezone.utc),
    )
    db.add(session)
    await db.flush()
    await db.refresh(session)
    # Commit before returning: get_db's post-yield commit runs only after the
    # response is sent, which races with the client's next request.
    await db.commit()
    _session_user_cache[session.id] = session.user_id
    return {"status": "success", "session_id": session.id, "user_id": str(session.user_id)}


@app.post("/api/validation")
async def store_validation(request: Request, db: AsyncSession = Depends(get_db)):
    """Store the per-point accuracy of one post-calibration validation run.

    Body: {session_id, attempt, points: [{point_index, target_x, target_y,
    mean_error_px, sample_count}]}. mean_error_px is null for a point where
    no gaze prediction was available.
    """
    body = await request.json()
    session_id = int(body["session_id"])
    if not await db.get(GazepointSession, session_id):
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    now = datetime.now(timezone.utc)
    rows = [
        ValidationPoint(
            session_id=session_id,
            attempt=int(body.get("attempt") or 1),
            point_index=int(p["point_index"]),
            target_x=float(p["target_x"]),
            target_y=float(p["target_y"]),
            mean_error_px=(
                float(p["mean_error_px"]) if p.get("mean_error_px") is not None else None
            ),
            sample_count=int(p.get("sample_count") or 0),
            created_at=now,
        )
        for p in body.get("points", [])
    ]
    db.add_all(rows)
    return {"status": "success", "stored": len(rows)}


def _parse_client_time(value: str | None) -> datetime | None:
    """Parse an ISO timestamp from the browser (Date.toISOString(), UTC 'Z')."""
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@app.post("/api/page-visits")
async def store_page_visit(request: Request, db: AsyncSession = Depends(get_db)):
    """Store one finished exam-page visit.

    Body: {session_id, visit_index, page_id, question_id, page_url,
    entered_at, left_at, entered_elapsed, duration_seconds}. Sent by the
    capture page when the participant leaves a page.
    """
    body = await request.json()
    session_id = int(body["session_id"])
    if not await db.get(GazepointSession, session_id):
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")

    duration = body.get("duration_seconds")
    db.add(
        PageVisit(
            session_id=session_id,
            visit_index=int(body.get("visit_index") or 0),
            page_id=body.get("page_id") or None,
            question_id=body.get("question_id") or None,
            page_url=body.get("page_url") or None,
            entered_at=_parse_client_time(body.get("entered_at")),
            left_at=_parse_client_time(body.get("left_at")),
            entered_elapsed=float(body.get("entered_elapsed") or 0),
            duration_seconds=float(duration) if duration is not None else None,
            created_at=datetime.now(timezone.utc),
        )
    )
    return {"status": "success"}


@app.post("/api/points")
async def store_points(request: Request, db: AsyncSession = Depends(get_db)):
    """Queue gaze points for the next batch write.

    Body: {points: [{session_id,x,y,timestamp,...}]}. Points are held in
    memory and flushed to Postgres as a single bulk insert every
    POINT_FLUSH_INTERVAL_SECONDS by `_flush_loop`, rather than being written
    on every request.
    """
    body = await request.json()
    points = body.get("points", [])
    if not points:
        return {"status": "success", "queued": 0}

    queued = []
    for p in points:
        session_id = int(p["session_id"])
        user_id = await _get_session_user_id(db, session_id)
        queued.append(
            dict(
                session_id=session_id,
                user_id=user_id,
                x=float(p["x"]),
                y=float(p["y"]),
                timestamp=float(p["timestamp"]),
                html_element_id=(p.get("html_element_id") or None),
            )
        )

    async with _buffer_lock:
        _point_buffer.extend(queued)

    return {"status": "success", "queued": len(queued)}


# --------------------------------------------------------------------------
# Retrieval endpoints
# --------------------------------------------------------------------------

@app.get("/api/sessions")
async def list_sessions(db: AsyncSession = Depends(get_db)):
    """List sessions with gaze-point and fixation counts, newest first."""
    point_counts = dict(
        (await db.execute(
            select(GazepointData.session_id, func.sum(GazepointData.sample_count))
            .group_by(GazepointData.session_id)
        )).all()
    )
    fixation_counts = dict(
        (await db.execute(
            select(Fixation.session_id, func.count(Fixation.id))
            .group_by(Fixation.session_id)
        )).all()
    )
    sessions = (await db.execute(
        select(GazepointSession).order_by(GazepointSession.id.desc())
    )).scalars().all()

    return {
        "status": "success",
        "data": [
            {
                "id": s.id,
                "participant_name": s.participant_name,
                "page_name": s.page_name,
                "browser_width": s.browser_width,
                "browser_height": s.browser_height,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "point_count": point_counts.get(s.id, 0),
                "fixation_count": fixation_counts.get(s.id, 0),
            }
            for s in sessions
        ],
    }


@app.get("/api/session/{session_id}")
async def get_session(session_id: int, db: AsyncSession = Depends(get_db)):
    """Return metadata for a single session."""
    session = await db.get(GazepointSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "status": "success",
        "data": {
            "id": session.id,
            "participant_name": session.participant_name,
            "page_name": session.page_name,
            "browser_width": session.browser_width,
            "browser_height": session.browser_height,
            "created_at": session.created_at.isoformat() if session.created_at else None,
        },
    }


@app.get("/api/points")
async def get_points(session_id: int, db: AsyncSession = Depends(get_db)):
    """Return raw gaze points (pixels) for a session, ordered by time.

    Reads gazepoint_data_flat, which unnests the packed gazepoint_data rows
    back into one row per sample, so callers see the same shape as before
    row-batching was introduced.
    """
    rows = (await db.execute(
        text(
            "SELECT x, y, timestamp FROM gazepoint_data_flat "
            "WHERE session_id = :session_id ORDER BY timestamp"
        ),
        {"session_id": session_id},
    )).mappings().all()
    return {
        "status": "success",
        "data": [{"x": r["x"], "y": r["y"], "timestamp": r["timestamp"]} for r in rows],
    }


@app.get("/api/fixations")
async def get_fixations(session_id: int, db: AsyncSession = Depends(get_db)):
    """Return processed fixations (normalized 0-1 coords) for a session."""
    rows = (await db.execute(
        select(Fixation)
        .where(Fixation.session_id == session_id)
        .order_by(Fixation.timestamp)
    )).scalars().all()
    return {
        "status": "success",
        "data": [
            {
                "fixation_id": r.fixation_id,
                "x": r.x,
                "y": r.y,
                "duration": r.duration,
                "timestamp": r.timestamp,
            }
            for r in rows
        ],
    }


# --------------------------------------------------------------------------
# Fixation processing
# --------------------------------------------------------------------------

def _clean_work_dirs() -> None:
    """Remove any leftover CSVs so the pipeline only sees the current session."""
    for d in PIPELINE_WORK_DIRS:
        for f in d.glob("*.csv"):
            f.unlink(missing_ok=True)


def _run_pipeline(session_id: str, screen_w: str, screen_h: str) -> None:
    """Run the 5-stage ST-DBSCAN fixation pipeline as sequential subprocesses.

    Blocking; call via asyncio.to_thread so the event loop stays responsive.
    Each script resolves `from db...` via its own directory (utils/), so cwd
    is set to the backend root and scripts are referenced as utils/<name>.py.
    """
    py = sys.executable
    steps = [
        [py, "utils/data_to_csv.py", session_id],
        [py, "utils/find_elbow.py", screen_w, screen_h, "all"],
        [py, "utils/stdbscan_tuning.py", screen_w, screen_h],
        [py, "utils/improved_gaze_converter.py", screen_w, screen_h],
        [py, "utils/fixation_store.py", session_id],
    ]
    for cmd in steps:
        result = subprocess.run(
            cmd, cwd=str(BASE_DIR), capture_output=True, text=True
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Pipeline step failed: {' '.join(cmd)}\n"
                f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            )


@app.post("/api/process")
async def process_session(request: Request):
    """Run the fixation pipeline for a session and store the resulting fixations."""
    body = await request.json()
    session_id = body.get("session_id")
    if session_id is None:
        raise HTTPException(status_code=400, detail="session_id is required")

    # Make sure any points still sitting in the in-memory batch buffer are
    # persisted before the pipeline reads the session's points from Postgres.
    await _flush_buffer()

    # Fetch dims + point count in a short-lived session, then release the
    # connection before the pipeline subprocesses touch the same SQLite file.
    async with AsyncSessionLocal() as db:
        session = await db.get(GazepointSession, int(session_id))
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        screen_w = str(session.browser_width or 1920)
        screen_h = str(session.browser_height or 1080)
        point_count = (await db.execute(
            select(func.coalesce(func.sum(GazepointData.sample_count), 0))
            .where(GazepointData.session_id == int(session_id))
        )).scalar_one()
        already = (await db.execute(
            select(func.count(Fixation.id))
            .where(Fixation.session_id == int(session_id))
        )).scalar_one()

    if already:
        return {"status": "complete", "message": "Fixations already processed",
                "fixation_count": already}

    if point_count < MIN_POINTS_FOR_FIXATIONS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Session has only {point_count} gaze points; at least "
                f"{MIN_POINTS_FOR_FIXATIONS} are needed for fixation processing. "
                "Record a longer session."
            ),
        )

    _clean_work_dirs()
    try:
        await asyncio.to_thread(_run_pipeline, str(session_id), screen_w, screen_h)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    async with AsyncSessionLocal() as db:
        count = (await db.execute(
            select(func.count(Fixation.id))
            .where(Fixation.session_id == int(session_id))
        )).scalar_one()

    return {"status": "complete", "fixation_count": count}


# --------------------------------------------------------------------------
# Static frontend (mounted last so /api/* routes take precedence)
# --------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
