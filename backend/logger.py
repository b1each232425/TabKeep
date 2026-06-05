import sys

from loguru import logger

logger.remove()
logger.add(
    sys.stderr,
    format=(
        "<green>{time:HH:mm:ss.SSS}</green> | "
        "<level>{level: <7}</level> | "
        "<cyan>{name}</cyan>:<cyan>{line}</cyan> - "
        "<level>{message}</level>"
    ),
    level="INFO",
    colorize=True,
)
