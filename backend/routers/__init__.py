"""
routers 子包入口:暴露 tabs router(其他 router 在 main.py 显式 import)。
"""
from .tabs import router

__all__ = ["router"]