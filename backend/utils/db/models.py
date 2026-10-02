import uuid
from datetime import datetime
from sqlalchemy import BigInteger, DateTime, Integer, Float, ForeignKey, String, Uuid
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base

# Number of raw gaze samples packed into a single gazepoint_data row.
GAZE_BATCH_SIZE = 50

class GazepointSession(Base):
    __tablename__ = "gazepoint_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, nullable=False, default=uuid.uuid4, index=True
    )
    # Free-text name/nickname/id the participant types in before starting.
    participant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    page_name: Mapped[str] = mapped_column(String(255), nullable=False)
    browser_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    browser_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Relationship back to fixations
    fixations: Mapped[list["Fixation"]] = relationship(
        "Fixation", back_populates="session", lazy="selectin"
    )
    data: Mapped[list["GazepointData"]] = relationship(
        "GazepointData", back_populates="session", uselist=False, lazy="selectin"
    )

class GazepointData(Base):
    """One row holds up to GAZE_BATCH_SIZE raw gaze samples, packed as parallel
    arrays (x_values[i], y_values[i], timestamps[i], html_element_ids[i] are
    all sample i), instead of one row per sample. This cuts row count/overhead
    while keeping every sample's data. Read it back sample-by-sample via the
    gazepoint_data_flat view (see db/views.py) rather than unpacking by hand.
    """
    __tablename__ = "gazepoint_data"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("gazepoint_sessions.id"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    x_values: Mapped[list[float]] = mapped_column(ARRAY(Float), nullable=False)
    y_values: Mapped[list[float]] = mapped_column(ARRAY(Float), nullable=False)
    timestamps: Mapped[list[float]] = mapped_column(ARRAY(Float), nullable=False)
    html_element_ids: Mapped[list[str | None]] = mapped_column(ARRAY(String(255)), nullable=False)
    sample_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    session: Mapped["GazepointSession"] = relationship(
        "GazepointSession", back_populates="data", lazy="selectin"
    )


class ValidationPoint(Base):
    """Accuracy of one evaluation point from the post-calibration check: the
    mean distance (px) between the point and the gaze predictions sampled
    while the participant looked at it. A session has one row per point per
    attempt; recalibrating adds a new attempt, and the highest attempt is the
    calibration the recording was made with.
    """
    __tablename__ = "validation_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("gazepoint_sessions.id"), nullable=False, index=True
    )
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    point_index: Mapped[int] = mapped_column(Integer, nullable=False)
    target_x: Mapped[float] = mapped_column(Float, nullable=False)
    target_y: Mapped[float] = mapped_column(Float, nullable=False)
    # NULL when no gaze prediction was available while the point was shown.
    mean_error_px: Mapped[float | None] = mapped_column(Float, nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Fixation(Base):
    __tablename__ = "fixation_points"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("gazepoint_sessions.id"), nullable=False, index=True
    )
    fixation_id: Mapped[int] = mapped_column(Integer, nullable=False)
    x: Mapped[float] = mapped_column(Float, nullable=False)
    y: Mapped[float] = mapped_column(Float, nullable=False)
    duration: Mapped[int] = mapped_column(BigInteger, nullable=False)
    timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationship to parent session
    session: Mapped["GazepointSession"] = relationship(
        "GazepointSession", back_populates="fixations", lazy="selectin"
    )
