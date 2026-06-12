"""
本地 API token 校验。

TabKeep 后端只监听 127.0.0.1,但浏览器网页也可能尝试请求本机端口。
写接口统一要求 `X-TabKeep-Token`, token 由扩展生成并通过 /config/sync 首次写入。
"""
from fastapi import Header, HTTPException

from services import storage


def require_api_token(x_tabkeep_token: str | None = Header(default=None)) -> None:
    """校验本地 API token。未初始化时提示用户先打开扩展完成同步。"""
    expected = storage.get_api_token()
    if not expected:
        raise HTTPException(status_code=401, detail="TabKeep API token 未初始化,请先打开扩展")
    if not x_tabkeep_token or x_tabkeep_token != expected:
        raise HTTPException(status_code=401, detail="TabKeep API token 无效")
