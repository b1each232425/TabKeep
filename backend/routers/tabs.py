from fastapi import APIRouter
from schemas.tab import TabData

router = APIRouter(prefix="/tabs", tags=["标签管理"])

# 内存存储（测试用）
tabs_storage: list[TabData] = []


@router.post("/", summary="接收 Extension 发送的标签数据")
def receive_tabs(tabs: list[TabData]) -> dict[str, int]:
    """接收并存储从 Chrome Extension 传来的标签页数据"""
    tabs_storage.clear()
    tabs_storage.extend(tabs)
    return {"received": len(tabs), "total": len(tabs_storage)}


@router.get("/", summary="获取所有存储的标签数据")
def get_tabs() -> list[TabData]:
    """返回所有已存储的标签页"""
    return tabs_storage