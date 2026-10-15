"""
FastAPI 应用入口。

文件结构按职能:
  1. imports
  2. lifespan 钩子(应用启动时初始化 storage)
  3. FastAPI app 实例 + CORS 中间件
  4. 路由注册(三个 router,各自管自己的 URL 前缀)
  5. 健康检查
  6. uvicorn 启动入口(`python main.py` 也能跑)
"""
import os
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager, suppress
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# 三个业务路由模块
from routers.tabs import router as tabs_router      # /tabs  —— 标签页同步
from routers.classify import router as classify_router  # /config + /classify —— 配置 + LLM 分类
from routers.notes import router as notes_router    # /notes/* —— 笔记集成 + 摘要
from routers.knowledge import router as knowledge_router  # /knowledge/* —— 本地知识库 + RAG
from routers.ocr import router as ocr_router          # /ocr/* —— 本地 OCR 模型
from routers.tab_groups import router as tab_groups_router  # /tab-groups —— 标签归档
from routers.news import router as news_router  # /news —— 本地资讯订阅采集

# 跨域 + 启动钩子
from services import storage
from services.news import collector as news_collector
from services.news import db as news_db
from services.news import web_sessions


# ─────────────────────────────────────────────────────────────
# 生命周期:启动时加载 config.json,关闭时无需清理
# ─────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # 启动:从 data/config.json 把 modelConfig / tabCategories / noteAdapter 读进内存
    storage.init()
    news_db.init_db()
    news_task = asyncio.create_task(news_collector.run_scheduler(), name="tabkeep-news-poller")
    yield  # 应用运行中
    news_task.cancel()
    with suppress(asyncio.CancelledError):
        await news_task
    news_collector.clear_source_locks()
    web_sessions.clear_sessions()
    # 关闭:loguru 自动 flush,SQLite 由连接上下文提交


# ─────────────────────────────────────────────────────────────
# FastAPI 实例
# ─────────────────────────────────────────────────────────────
APP_VERSION = "1.0.0"
DEFAULT_BACKEND_HOST = "127.0.0.1"
DEFAULT_BACKEND_PORT = 38471


def backend_host() -> str:
    return os.getenv("TABKEEP_BACKEND_HOST", DEFAULT_BACKEND_HOST).strip() or DEFAULT_BACKEND_HOST


def backend_port() -> int:
    value = os.getenv("TABKEEP_BACKEND_PORT", str(DEFAULT_BACKEND_PORT)).strip()
    port = int(value)
    if port <= 0 or port > 65535:
        raise ValueError(f"Invalid TABKEEP_BACKEND_PORT: {value}")
    return port


app = FastAPI(title="TabKeep API", version=APP_VERSION, lifespan=lifespan)

# 开发环境允许所有来源跨域;生产部署应该收紧
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册业务路由(每个 router 在自己的模块里定义 prefix)
app.include_router(tabs_router)
app.include_router(classify_router)
app.include_router(notes_router)
app.include_router(knowledge_router)
app.include_router(ocr_router)
app.include_router(tab_groups_router)
app.include_router(news_router)
app.mount(
    "/reader",
    StaticFiles(directory=Path(__file__).parent / "web_static", html=True, check_dir=False),
    name="news-reader",
)


# ─────────────────────────────────────────────────────────────
# 健康检查
# ─────────────────────────────────────────────────────────────
@app.get("/", summary="健康检查")
def read_root() -> dict[str, str]:
    """用于检查后端是否启动。不读 storage,纯 echo。"""
    return {"message": "TabKeep API Running", "version": APP_VERSION}


# ─────────────────────────────────────────────────────────────
# 命令行启动:`python main.py` 等价于 `uvicorn main:app --host 127.0.0.1 --port 38471`
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=backend_host(), port=backend_port())
