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
    page_name: str
    browser_width: int | None = None
    browser_height: int | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}

# ----------------------------
# GazepointData Schemas
# ----------------------------

class GazepointDataOut(BaseModel):
    id: int
    session_id: int
    user_id: UUID
    x: float
    y: float
    timestamp: float
    element: str | None = None
    html_element_id: str | None = None
    subsection: str | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}
