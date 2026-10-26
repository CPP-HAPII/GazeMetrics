"""Database tables.

Four tables, one row per thing, with the participant's name on every row so
each table reads on its own in Supabase:

  sessions      one participant session: who, when, screen, calibration result
  pages         one test page shown: timing, plus the answer chosen there
  calibration   one accuracy check after calibration, with its 18 points
  gaze          gaze samples, packed GAZE_BATCH_SIZE to a row (to save space);
                read them one per row through the gaze_readable view

plus `fixations`, filled only when the viewer's "Process fixations" is used.

Times called seconds_from_start / *_seconds count from the moment the
participant clicked "Start recording", so gaze, pages and answers line up.
"""
from datetime import datetime
from sqlalchemy import BigInteger, DateTime, Integer, Float, ForeignKey, String
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base

# Number of gaze samples packed into one row of the gaze table.
GAZE_BATCH_SIZE = 50


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # The ID the participant typed on the welcome page.
    participant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    test_name: Mapped[str | None] = mapped_column(String(255), nullable=True)   # e.g. exam1
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    browser_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    browser_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Average error of the last accuracy check (the calibration the recording used).
    calibration_error_px: Mapped[float | None] = mapped_column(Float, nullable=True)


class Page(Base):
    """One test page shown to the participant, with the answer given on it.
    Each question has its own page, so seconds_on_page is the time spent on
    that question (or reading time, for a reading passage)."""
    __tablename__ = "pages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sessions.id"), nullable=False, index=True
    )
    participant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    page_order: Mapped[int] = mapped_column(Integer, nullable=False)        # 1 = first page shown
    page_id: Mapped[str | None] = mapped_column(String(255), nullable=True)  # q12, passage-3, passage-3-q1, ...
    # directions, audio (listening question), text (written question) or reading (passage).
    page_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    seconds_from_start: Mapped[float | None] = mapped_column(Float, nullable=True)
    seconds_on_page: Mapped[float | None] = mapped_column(Float, nullable=True)
    # The answer the participant ended with on this page (empty if none)...
    answer: Mapped[str | None] = mapped_column(String(8), nullable=True)     # a, b, c or d
    answer_text: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    answered_at_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    # ...and every answer they clicked, in order, e.g.
    # [{"answer": "b", "seconds": 30.1}, {"answer": "c", "seconds": 31.4}]
    answer_history: Mapped[list | None] = mapped_column(JSONB, nullable=True)


class Calibration(Base):
    """One accuracy check after calibration. Recalibrating adds a new attempt;
    the highest attempt is the calibration the recording was made with."""
    __tablename__ = "calibration"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sessions.id"), nullable=False, index=True
    )
    participant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Average over the points where the tracker produced a reading.
    mean_error_px: Mapped[float | None] = mapped_column(Float, nullable=True)
    points_with_data: Mapped[int] = mapped_column(Integer, nullable=False)
    # One entry per point: {"point", "x", "y", "error_px", "samples"}.
    points: Mapped[list] = mapped_column(JSONB, nullable=False)


class Gaze(Base):
    """Up to GAZE_BATCH_SIZE gaze samples, packed as parallel arrays
    (x_values[i], y_values[i], seconds_from_start[i], page_ids[i] and
    element_ids[i] are all sample i). Read through the gaze_readable view."""
    __tablename__ = "gaze"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sessions.id"), nullable=False, index=True
    )
    participant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer, nullable=False)
    seconds_from_start: Mapped[list[float]] = mapped_column(ARRAY(Float), nullable=False)
    x_values: Mapped[list[float]] = mapped_column(ARRAY(Float), nullable=False)
    y_values: Mapped[list[float]] = mapped_column(ARRAY(Float), nullable=False)
    page_ids: Mapped[list[str | None]] = mapped_column(ARRAY(String(255)), nullable=False)
    element_ids: Mapped[list[str | None]] = mapped_column(ARRAY(String(255)), nullable=False)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Fixation(Base):
    """Fixations found by the ST-DBSCAN pipeline (viewer: Process fixations)."""
    __tablename__ = "fixations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sessions.id"), nullable=False, index=True
    )
    fixation_id: Mapped[int] = mapped_column(Integer, nullable=False)
    x: Mapped[float] = mapped_column(Float, nullable=False)
    y: Mapped[float] = mapped_column(Float, nullable=False)
    duration: Mapped[int] = mapped_column(BigInteger, nullable=False)
    timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)
