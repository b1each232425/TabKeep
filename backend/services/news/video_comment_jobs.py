"""话题搜索视频评论的短期内存任务管理。"""

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from schemas.news import (
    TopicSearchCommentTaskResponse,
    TopicSearchVideoComments,
    VideoTopicSearchProvider,
)
from services.news.topic_search_diagnostics import log_topic_search_diagnostic

MAX_RETAINED_TASKS = 20
MAX_COMMENTS_PER_VIDEO = 10
MAX_PROVIDER_CONCURRENCY = 2
MIN_VIDEO_INTERVAL_SECONDS = 1.0
ACTIVE_TASK_TTL_SECONDS = 15 * 60
COMPLETED_TASK_TTL_SECONDS = 30 * 60
EXPIRED_TOMBSTONE_SECONDS = 5 * 60
JANITOR_INTERVAL_SECONDS = 30
VIDEO_PROVIDERS = {"douyin", "bilibili", "kuaishou"}
VIDEO_PROVIDER_DOMAINS = {
    "douyin": ("douyin.com",),
    "bilibili": ("bilibili.com", "b23.tv"),
    "kuaishou": ("kuaishou.com", "gifshow.com"),
}

VideoItem = dict[str, Any]
CommentPayload = dict[str, Any]
CommentCollector = Callable[[str, VideoItem], Awaitable[list[CommentPayload]]]


class VideoCommentCollectionError(Exception):
    """供平台适配器返回安全状态，不把原始异常或凭据暴露到任务快照。"""

    def __init__(
        self,
        state: str,
        message: str,
        stop_provider: bool = False,
        error_code: str = "COMMENT_COLLECTION_FAILED",
        diagnostics: dict[str, str | int | bool | None] | None = None,
        partial_comments: list[CommentPayload] | None = None,
    ) -> None:
        if state not in {"failed", "login_required", "limited"}:
            raise ValueError("不支持的评论采集错误状态")
        super().__init__(message)
        self.state = state
        self.message = " ".join(message.split())[:240]
        self.stop_provider = stop_provider
        self.error_code = error_code
        self.diagnostics = diagnostics or {}
        self.partial_comments = partial_comments or []


class VideoCommentJobManager:
    """只在当前后端进程保存视频评论和任务状态。"""

    def __init__(self) -> None:
        self._jobs: dict[str, dict[str, Any]] = {}
        self._running: dict[str, asyncio.Task[None]] = {}
        self._expired_ids: dict[str, float] = {}
        self._provider_semaphores: dict[str, asyncio.Semaphore] = {}
        self._provider_pacing_locks: dict[str, asyncio.Lock] = {}
        self._provider_last_start: dict[str, float] = {}
        self._janitor: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    async def create(
        self,
        items: list[VideoItem],
        collector: CommentCollector,
        request_id: str | None = None,
    ) -> str | None:
        """筛选并复制视频白名单字段，然后立即启动短期评论任务。"""
        videos: list[dict[str, Any]] = []
        for item in items:
            provider = str(item.get("provider") or "")
            key = str(item.get("key") or "").strip()
            if provider not in VIDEO_PROVIDERS or not key:
                continue
            videos.append(
                {
                    "key": key[:320],
                    "provider": provider,
                    "providerTitle": str(item.get("providerTitle") or provider)[:80],
                    "title": str(item.get("title") or "")[:500],
                    "url": _safe_platform_url(provider, item.get("url")),
                    "apiVideoId": (
                        str(item.get("apiVideoId") or "")[:32]
                        if provider == "bilibili" and str(item.get("apiVideoId") or "").isdigit()
                        else None
                    ),
                    "state": "queued",
                    "message": "",
                    "comments": [],
                }
            )
        if not videos:
            return None

        async with self._lock:
            self._cleanup()
            self._make_room()
            task_id = uuid.uuid4().hex
            created_at = _now()
            self._jobs[task_id] = {
                "taskId": task_id,
                "requestId": request_id,
                "state": "queued",
                "createdAt": _iso(created_at),
                "expiresAt": _iso(created_at + timedelta(seconds=ACTIVE_TASK_TTL_SECONDS)),
                "expiresMonotonic": time.monotonic() + ACTIVE_TASK_TTL_SECONDS,
                "videos": videos,
            }
            provider_counts: dict[str, int] = {}
            for video in videos:
                provider = str(video["provider"])
                provider_counts[provider] = provider_counts.get(provider, 0) + 1
            log_topic_search_diagnostic(
                "video_comment_task",
                request_id=request_id,
                task_id=task_id,
                stage="task_created",
                state="queued",
                video_count=len(videos),
            )
            for provider, video_count in provider_counts.items():
                log_topic_search_diagnostic(
                    "video_comment_task",
                    request_id=request_id,
                    task_id=task_id,
                    provider=provider,
                    stage="provider_queued",
                    state="queued",
                    video_count=video_count,
                )
            if self._janitor is None or self._janitor.done():
                self._janitor = asyncio.create_task(self._run_janitor(), name="tabkeep-video-comment-janitor")
            self._running[task_id] = asyncio.create_task(
                self._run(task_id, collector),
                name=f"tabkeep-video-comments-{task_id}",
            )
        return task_id

    def get(self, task_id: str) -> dict[str, Any] | None:
        """返回经过 Pydantic 白名单校验的任务快照。"""
        self._cleanup()
        job = self._jobs.get(task_id)
        if job is None:
            return None
        return TopicSearchCommentTaskResponse(
            taskId=job["taskId"],
            state=job["state"],
            createdAt=job["createdAt"],
            expiresAt=job["expiresAt"],
            providers=self._provider_snapshots(job["videos"]),
            items=[TopicSearchVideoComments(**self._video_snapshot(video)) for video in job["videos"]],
        ).model_dump(by_alias=True)

    def is_expired(self, task_id: str) -> bool:
        """判断任务是否已过期并保留了短暂的 410 状态标记。"""
        self._cleanup()
        return task_id in self._expired_ids

    async def close(self) -> None:
        """应用关闭时停止清理器和所有仍在运行的采集任务。"""
        tasks = list(self._running.values())
        if self._janitor is not None:
            self._janitor.cancel()
            tasks.append(self._janitor)
            self._janitor = None
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._running.clear()
        self._jobs.clear()
        self._expired_ids.clear()
        self._provider_semaphores.clear()
        self._provider_pacing_locks.clear()
        self._provider_last_start.clear()

    async def _run(self, task_id: str, collector: CommentCollector) -> None:
        job = self._jobs.get(task_id)
        if job is None:
            return
        job["state"] = "running"
        request_id = str(job.get("requestId") or "") or None
        log_topic_search_diagnostic(
            "video_comment_task",
            request_id=request_id,
            task_id=task_id,
            stage="task_started",
            state="running",
            video_count=len(job["videos"]),
        )
        stopped_providers: dict[str, str] = {}

        def mark_provider_paused(video: dict[str, Any], provider: str, video_hash: str) -> None:
            video["state"] = "limited"
            video["message"] = stopped_providers[provider]
            log_topic_search_diagnostic(
                "video_comment_task",
                request_id=request_id,
                task_id=task_id,
                provider=provider,
                video_hash=video_hash,
                stage="provider_paused",
                state="limited",
                error_code="PROVIDER_PAUSED",
            )

        async def collect_one(video: dict[str, Any]) -> None:
            provider = str(video["provider"])
            video_key = str(video["key"])
            video_hash = video_key.partition(":")[2]
            if provider in stopped_providers:
                mark_provider_paused(video, provider, video_hash)
                return

            semaphore = self._provider_semaphores.setdefault(provider, asyncio.Semaphore(MAX_PROVIDER_CONCURRENCY))
            pacing_lock = self._provider_pacing_locks.setdefault(provider, asyncio.Lock())
            async with semaphore:
                # 等待并发名额期间，平台上的其他视频可能已经触发了限流或登录墙。
                if provider in stopped_providers:
                    mark_provider_paused(video, provider, video_hash)
                    return
                async with pacing_lock:
                    loop_time = asyncio.get_running_loop().time()
                    wait_seconds = max(
                        0.0,
                        self._provider_last_start.get(provider, 0.0) + MIN_VIDEO_INTERVAL_SECONDS - loop_time,
                    )
                    if wait_seconds:
                        await asyncio.sleep(wait_seconds)
                    # 节流等待期间也可能有并行请求报告平台限制，再检查一次。
                    if provider in stopped_providers:
                        mark_provider_paused(video, provider, video_hash)
                        return
                    self._provider_last_start[provider] = asyncio.get_running_loop().time()
                video["state"] = "running"
                started = time.perf_counter()
                log_topic_search_diagnostic(
                    "video_comment_task",
                    request_id=request_id,
                    task_id=task_id,
                    provider=provider,
                    video_hash=video_hash,
                    stage="video_started",
                    state="running",
                )
                try:
                    comments = await collector(provider, dict(video))
                except asyncio.CancelledError:
                    raise
                except VideoCommentCollectionError as error:
                    video["comments"] = self._safe_comments(video, error.partial_comments)
                    video["state"] = "partial" if video["comments"] else error.state
                    video["message"] = error.message
                    log_topic_search_diagnostic(
                        "video_comment_task",
                        request_id=request_id,
                        task_id=task_id,
                        provider=provider,
                        video_hash=video_hash,
                        stage="video_finished",
                        state=video["state"],
                        error_code=error.error_code,
                        failure_state=error.state,
                        duration_ms=round((time.perf_counter() - started) * 1000),
                        **error.diagnostics,
                    )
                    if error.stop_provider:
                        stopped_providers[provider] = error.message or "平台暂时不可用，已暂停该平台的评论采集。"
                except Exception as error:
                    video["state"] = "failed"
                    video["message"] = "评论暂时无法读取。"
                    log_topic_search_diagnostic(
                        "video_comment_task",
                        request_id=request_id,
                        task_id=task_id,
                        provider=provider,
                        video_hash=video_hash,
                        stage="video_finished",
                        state="failed",
                        error_code="UNEXPECTED_ERROR",
                        error_type=type(error).__name__,
                        duration_ms=round((time.perf_counter() - started) * 1000),
                    )
                else:
                    video["comments"] = self._safe_comments(video, comments)
                    video["state"] = "completed"
                    log_topic_search_diagnostic(
                        "video_comment_task",
                        request_id=request_id,
                        task_id=task_id,
                        provider=provider,
                        video_hash=video_hash,
                        stage="video_finished",
                        state="completed",
                        comment_count=len(video["comments"]),
                        duration_ms=round((time.perf_counter() - started) * 1000),
                    )

        try:
            await asyncio.gather(*(collect_one(video) for video in job["videos"]))
        except asyncio.CancelledError:
            log_topic_search_diagnostic(
                "video_comment_task",
                request_id=request_id,
                task_id=task_id,
                stage="task_cancelled",
                state="cancelled",
                video_count=len(job["videos"]),
            )
            raise
        finally:
            self._running.pop(task_id, None)

        states = [str(video["state"]) for video in job["videos"]]
        if states and all(state == "completed" for state in states):
            final_state = "completed"
        elif states and all(state in {"failed", "limited", "login_required"} for state in states):
            final_state = "failed"
        else:
            final_state = "partial"
        job["state"] = final_state
        self._set_completed_expiry(job)
        log_topic_search_diagnostic(
            "video_comment_task",
            request_id=request_id,
            task_id=task_id,
            stage="task_finished",
            state=final_state,
            video_count=len(job["videos"]),
            comment_count=sum(len(video["comments"]) for video in job["videos"]),
        )

    def _safe_comments(self, video: dict[str, Any], comments: list[CommentPayload]) -> list[dict[str, Any]]:
        safe: list[dict[str, Any]] = []
        for index, comment in enumerate(comments[:MAX_COMMENTS_PER_VIDEO]):
            if not isinstance(comment, dict):
                continue
            content = str(comment.get("content") or "").strip()
            if not content:
                continue
            raw_like_count = comment.get("likeCount")
            try:
                like_count = (
                    max(0, int(raw_like_count))
                    if raw_like_count is not None and not isinstance(raw_like_count, bool)
                    else None
                )
            except (TypeError, ValueError, OverflowError):
                like_count = None
            safe.append(
                {
                    "key": str(comment.get("key") or f"{video['key']}:comment:{index}")[:400],
                    "author": str(comment.get("author") or "")[:160] or None,
                    "content": content[:4000],
                    "publishedAt": str(comment.get("publishedAt") or "")[:100] or None,
                    "likeCount": like_count,
                    "url": _safe_platform_url(str(video["provider"]), comment.get("url")),
                }
            )
        return safe

    def _provider_snapshots(self, videos: list[dict[str, Any]]) -> list[dict[str, Any]]:
        snapshots: list[dict[str, Any]] = []
        for provider in dict.fromkeys(str(video["provider"]) for video in videos):
            provider_videos = [video for video in videos if video["provider"] == provider]
            states = [str(video["state"]) for video in provider_videos]
            terminal = {"completed", "partial", "failed", "login_required", "limited"}
            if all(state == "queued" for state in states):
                state = "queued"
            elif any(state == "running" for state in states) or any(state == "queued" for state in states):
                state = "running"
            elif all(value == "completed" for value in states):
                state = "completed"
            elif all(value in {"failed", "limited", "login_required"} for value in states):
                state = "failed"
            else:
                state = "partial"
            messages = list(dict.fromkeys(str(video["message"]) for video in provider_videos if video["message"]))
            snapshots.append(
                {
                    "provider": provider,
                    "title": str(provider_videos[0]["providerTitle"]),
                    "state": state if state in terminal | {"queued", "running"} else "partial",
                    "message": "；".join(messages)[:240],
                    "videoCount": len(provider_videos),
                    "completedVideoCount": sum(value == "completed" for value in states),
                    "commentCount": sum(len(video["comments"]) for video in provider_videos),
                }
            )
        return snapshots

    def _video_snapshot(self, video: dict[str, Any]) -> dict[str, Any]:
        return {
            "key": video["key"],
            "provider": video["provider"],
            "providerTitle": video["providerTitle"],
            "title": video["title"],
            "url": video["url"],
            "state": video["state"],
            "message": video["message"],
            "comments": video["comments"][:MAX_COMMENTS_PER_VIDEO],
        }

    async def _run_janitor(self) -> None:
        try:
            while True:
                await asyncio.sleep(JANITOR_INTERVAL_SECONDS)
                self._cleanup()
        except asyncio.CancelledError:
            raise

    def _cleanup(self) -> None:
        now_monotonic = time.monotonic()
        for task_id, job in list(self._jobs.items()):
            if job["state"] != "expired" and now_monotonic >= float(job["expiresMonotonic"]):
                self._expire(task_id, job)
            elif job["state"] == "expired" and now_monotonic >= float(job.get("purgeMonotonic", now_monotonic)):
                self._jobs.pop(task_id, None)
        for task_id, purge_at in list(self._expired_ids.items()):
            if now_monotonic >= purge_at:
                self._expired_ids.pop(task_id, None)

    def _expire(self, task_id: str, job: dict[str, Any]) -> None:
        task = self._running.get(task_id)
        if task is not None and not task.done():
            task.cancel()
        job["state"] = "expired"
        job["videos"] = []
        job["purgeMonotonic"] = time.monotonic() + EXPIRED_TOMBSTONE_SECONDS
        self._expired_ids[task_id] = float(job["purgeMonotonic"])
        if len(self._expired_ids) > MAX_RETAINED_TASKS:
            oldest_expired_id = min(self._expired_ids, key=self._expired_ids.get)
            self._expired_ids.pop(oldest_expired_id, None)

    def _make_room(self) -> None:
        while len(self._jobs) >= MAX_RETAINED_TASKS:
            finished = [
                (task_id, job)
                for task_id, job in self._jobs.items()
                if job["state"] not in {"queued", "running"}
            ]
            oldest_id, oldest_job = min(finished or list(self._jobs.items()), key=lambda pair: pair[1]["createdAt"])
            self._expire(oldest_id, oldest_job)
            self._jobs.pop(oldest_id, None)

    def _set_completed_expiry(self, job: dict[str, Any]) -> None:
        expires_at = _now() + timedelta(seconds=COMPLETED_TASK_TTL_SECONDS)
        job["expiresAt"] = _iso(expires_at)
        job["expiresMonotonic"] = time.monotonic() + COMPLETED_TASK_TTL_SECONDS


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat()


def _safe_platform_url(provider: str, value: Any) -> str | None:
    """只保留对应平台的 HTTP(S) 链接，移除用户信息、片段和查询参数。"""
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parsed = urlsplit(value.strip())
        hostname = (parsed.hostname or "").casefold().rstrip(".")
        if parsed.scheme.casefold() not in {"http", "https"} or not hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        if not any(hostname == domain or hostname.endswith(f".{domain}") for domain in VIDEO_PROVIDER_DOMAINS[provider]):
            return None
        return urlunsplit((parsed.scheme.casefold(), parsed.netloc.casefold(), parsed.path[:1800], "", ""))
    except (KeyError, ValueError):
        return None


video_comment_jobs = VideoCommentJobManager()
