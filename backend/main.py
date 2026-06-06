from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers.tabs import router as tabs_router
from routers.classify import router as classify_router
from routers.notes import router as notes_router
from services import storage


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    storage.init()
    yield


app = FastAPI(title="TabKeep API", version="0.1.0", lifespan=lifespan)

# 允许跨域（开发环境）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(tabs_router)
app.include_router(classify_router)
app.include_router(notes_router)


@app.get("/", summary="健康检查")
def read_root() -> dict[str, str]:
    """API 健康检查"""
    return {"message": "TabKeep API Running", "version": "0.1.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=38471)