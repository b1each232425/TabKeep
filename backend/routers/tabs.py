"""
/tabs 路由 —— 接收 + 读取 extension 推送的标签页数据。

当前实现是**纯内存**(模块级 list,重启清空),仅供联调用。
正式版应该把数据落 DB,这里没做。
"""
from fastapi import APIRouter, Depends
from schemas.tab import TabData
from services.auth import require_api_token

router = APIRouter(prefix="/tabs", tags=["标签管理"], dependencies=[Depends(require_api_token)])

# 内存存储(测试用,重启清空)
tabs_storage: list[TabData] = []


@router.post("/", summary="接收 Extension 发送的标签数据")
def receive_tabs(tabs: list[TabData]) -> dict[str, int]:
    """覆盖式写入;返回 (received, total)。"""
    tabs_storage.clear()
    tabs_storage.extend(tabs)
    return {"received": len(tabs), "total": len(tabs_storage)}


@router.get("/", summary="获取所有存储的标签数据")
def get_tabs() -> list[TabData]:
    """返回所有已存储的标签页。"""
    return tabs_storage
