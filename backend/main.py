from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers.tabs import router as tabs_router

app = FastAPI(title="TabKeep API", version="0.1.0")

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


@app.get("/", summary="健康检查")
def read_root():
    """API 健康检查"""
    return {"message": "TabKeep API Running", "version": "0.1.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=38471)