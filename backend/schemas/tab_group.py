from typing import Literal

from pydantic import BaseModel, Field


TabGroupColor = Literal[
    "grey",
    "blue",
    "red",
    "yellow",
    "green",
    "pink",
    "purple",
    "cyan",
    "orange",
]


class TabGroupTab(BaseModel):
    url: str = Field(min_length=1, max_length=8192)
    title: str = Field(default="", max_length=2048)
    favIconUrl: str | None = Field(default=None, max_length=8192)
    index: int = Field(ge=0)
    active: bool = False


class TabGroupSnapshot(BaseModel):
    nativeGroupId: int
    archiveId: str | None = None
    title: str | None = Field(default=None, max_length=256)
    color: TabGroupColor
    collapsed: bool = False
    windowId: int | None = None
    tabs: list[TabGroupTab]


class TabGroupSnapshotRequest(BaseModel):
    browserInstanceId: str = Field(min_length=1, max_length=128)
    browserSessionId: str = Field(min_length=1, max_length=128)
    browser: Literal["chrome", "edge"]
    complete: bool = True
    groups: list[TabGroupSnapshot]


class TabGroupAssignment(BaseModel):
    nativeGroupId: int
    archiveId: str | None
    suppressed: bool = False


class TabGroupSnapshotResponse(BaseModel):
    assignments: list[TabGroupAssignment]


class TabGroupArchive(BaseModel):
    id: str
    browserInstanceId: str
    browser: Literal["chrome", "edge"]
    title: str
    color: TabGroupColor
    collapsed: bool
    tabs: list[TabGroupTab]
    isOpen: bool
    browserOnline: bool
    browserReady: bool
    updatedAt: str


class TabGroupArchiveList(BaseModel):
    items: list[TabGroupArchive]


class TabGroupRestoreRequest(BaseModel):
    target: Literal["current", "new"]


class TabGroupCommandResponse(BaseModel):
    commandId: str
    status: Literal["queued"]


class TabGroupDeleteResponse(BaseModel):
    deleted: bool
    status: Literal["deleted", "queued"]
    commandId: str | None = None
