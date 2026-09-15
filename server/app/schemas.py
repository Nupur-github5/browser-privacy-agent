from typing import Literal, Optional, Union

from pydantic import BaseModel, Field


class BBox(BaseModel):
    x: float = 0
    y: float = 0
    width: float = 0
    height: float = 0


class Element(BaseModel):
    target_id: int
    role: str
    label: str = ""
    type: str = ""
    value: Union[str, bool, None] = None
    bbox: BBox = Field(default_factory=BBox)
    visible: bool = True


class VisionRegion(BaseModel):
    kind: str
    bbox: BBox = Field(default_factory=BBox)
    redacted: bool = True


class SanitizedState(BaseModel):
    state_id: str
    url: str
    title: str = ""
    task: str = ""
    elements: list[Element] = Field(default_factory=list)
    available_tokens: list[str] = Field(default_factory=list)
    vision_regions: list[VisionRegion] = Field(default_factory=list)


class ClickAction(BaseModel):
    action: Literal["click"]
    target_id: int
    reason: str = ""


class TypeAction(BaseModel):
    action: Literal["type"]
    target_id: int
    value: str
    reason: str = ""


class ScrollAction(BaseModel):
    action: Literal["scroll"]
    direction: Literal["up", "down"]
    amount: int = 400
    reason: str = ""


class DoneAction(BaseModel):
    action: Literal["done"]
    reason: str = ""


Action = Union[ClickAction, TypeAction, ScrollAction, DoneAction]


class HistoryEntry(BaseModel):
    action: dict
    result: Optional[dict] = None


class AgentStepRequest(BaseModel):
    state: SanitizedState
    history: list[HistoryEntry] = Field(default_factory=list)


class AgentStepResponse(BaseModel):
    action: dict
    repaired: bool = False
    raw_llm_output: Optional[str] = None
