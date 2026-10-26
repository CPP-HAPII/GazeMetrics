from pydantic import BaseModel


# ----------------------------
# Fixation Schemas (used by the fixation pipeline, utils/fixation_store.py)
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
