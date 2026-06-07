"""
集中式日志配置：整个后端只用这一个 logger 实例(从 loguru 导入)。

`logger` 在其他文件统一 `from logger import logger` 使用。
- 移除 loguru 默认 handler(避免重复输出)
- 加一个 stderr handler,带颜色和模块定位(<name>:<line>)
- 最低 level=INFO,过滤掉 DEBUG
"""
import sys

from loguru import logger

# 清掉 loguru 自带 handler,只用我们下面定义的这一个
logger.remove()

# 唯一输出:彩色 stderr,适合开发环境
logger.add(
    sys.stderr,
    format=(
        "<green>{time:HH:mm:ss.SSS}</green> | "   # 时间,绿色
        "<level>{level: <7}</level> | "          # 日志级别(INFO/WARN/ERROR 等)
        "<cyan>{name}</cyan>:<cyan>{line}</cyan> - "  # 模块名 + 行号,青色
        "<level>{message}</level>"                # 日志内容
    ),
    level="INFO",
    colorize=True,
)
