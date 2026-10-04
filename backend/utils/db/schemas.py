from pydantic import BaseModel
from datetime import datetime
from uuid import UUID


# ----------------------------
# Fixation Schemas
# ----------------------------

class FixationBase(BaseModel):
    fixation_id: int
    x: float
    y: float
    duration: int
    timestamp: int

class FixationCreate(FixationBase):
    session_id: int

class FixationOut(FixationBase):
    id: int
    session_id: int

    model_config = {"from_attributes": True}


# ----------------------------
# GazepointSession Schemas
# ----------------------------

class GazepointSessionBase(BaseModel):
    page_name: str
    browser_width: int | None = None
    browser_height: int | None = None

class GazepointSessionOut(GazepointSessionBase):
    id: int
    user_id: UUID
    participant_name: str | None = None
    page_name: str
    browser_width: int | None = None
    browser_height: int | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}

# ----------------------------
# GazepointData Schemas
# ----------------------------

class GazepointBatchOut(BaseModel):
    """One packed row: up to GAZE_BATCH_SIZE samples as parallel arrays."""
    id: int
    session_id: int
    user_id: UUID
    x_values: list[float]
    y_values: list[float]
    timestamps: list[float]
    html_element_ids: list[str | None]
    sample_count: int
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class GazepointDataOut(BaseModel):
    """One raw sample, as read from the gazepoint_data_flat view."""
    id: int
    session_id: int
    user_id: UUID
    x: float
    y: float
    timestamp: float
    html_element_id: str | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}
