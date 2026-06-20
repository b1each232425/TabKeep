"""
本地 API token 校验。

TabKeep 后端只监听 127.0.0.1,但浏览器网页也可能尝试请求本机端口。
默认保留 `X-TabKeep-Token` 校验;开发环境可通过 TABKEEP_DISABLE_AUTH=1 关闭。
"""
import os

from fastapi import Header, HTTPException

from services import storage


def is_auth_disabled() -> bool:
    """开发环境开关。值为 1/true/yes/on 时跳过本地 token 校验。"""
    return os.getenv("TABKEEP_DISABLE_AUTH", "").strip().lower() in {"1", "true", "yes", "on"}


def require_api_token(x_tabkeep_token: str | None = Header(default=None)) -> None:
    """校验本地 API token。未初始化时提示用户先打开扩展完成同步。"""
    if is_auth_disabled():
        return
    expected = storage.get_api_token()
    if not expected:
        raise HTTPException(status_code=401, detail="TabKeep API token 未初始化,请先打开扩展")
    if not x_tabkeep_token or x_tabkeep_token != expected:
        raise HTTPException(status_code=401, detail="TabKeep API token 无效")
