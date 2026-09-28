import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect

from schemas.tab_group import (
    TabGroupArchiveList,
    TabGroupCommandResponse,
    TabGroupDeleteResponse,
    TabGroupRestoreRequest,
    TabGroupSnapshotRequest,
    TabGroupSnapshotResponse,
)
from services import storage, tab_groups
from services.auth import is_auth_disabled, require_api_token


router = APIRouter(prefix="/tab-groups", tags=["标签归档"])
_connections: dict[str, WebSocket] = {}
_sessions: dict[str, str] = {}
_ready_instances: set[str] = set()
_complete_instances: set[str] = set()
_connections_lock = asyncio.Lock()


async def _send_pending(
    browser_instance_id: str,
    websocket: WebSocket,
    browser_session_id: str,
    inventory_complete: bool,
) -> None:
    for command in tab_groups.pending_commands(
        browser_instance_id,
        browser_session_id=browser_session_id,
        inventory_complete=inventory_complete,
    ):
        await websocket.send_json({"type": "command", "command": command})


@router.get("", response_model=TabGroupArchiveList, dependencies=[Depends(require_api_token)])
async def list_tab_groups() -> TabGroupArchiveList:
    async with _connections_lock:
        complete_instances = set(_complete_instances)
    items = [
        archive.model_copy(
            update={"browserReady": archive.browserInstanceId in complete_instances}
        )
        for archive in tab_groups.list_archives()
    ]
    return TabGroupArchiveList(items=items)


@router.post(
    "/snapshot",
    response_model=TabGroupSnapshotResponse,
    dependencies=[Depends(require_api_token)],
)
async def sync_tab_groups(req: TabGroupSnapshotRequest) -> TabGroupSnapshotResponse:
    async with _connections_lock:
        current_session_id = _sessions.get(req.browserInstanceId)
        is_connected = req.browserInstanceId in _connections
    if is_connected and current_session_id != req.browserSessionId:
        raise HTTPException(status_code=409, detail="浏览器会话已更新，请重新同步标签组")
    assignments = tab_groups.sync_snapshot(req)
    return TabGroupSnapshotResponse(assignments=assignments)


@router.post(
    "/{archive_id}/restore",
    response_model=TabGroupCommandResponse,
    status_code=202,
    dependencies=[Depends(require_api_token)],
)
async def restore_tab_group(
    archive_id: str,
    req: TabGroupRestoreRequest,
) -> TabGroupCommandResponse:
    archive = tab_groups.get_archive(archive_id)
    if archive is None:
        raise HTTPException(status_code=404, detail="标签归档不存在")

    browser_instance_id = str(archive["browserInstanceId"])
    async with _connections_lock:
        websocket = _connections.get(browser_instance_id)
        current_session_id = _sessions.get(browser_instance_id, "")
        is_ready = browser_instance_id in _ready_instances
        inventory_complete = browser_instance_id in _complete_instances
    if (
        websocket is None
        or not is_ready
        or not inventory_complete
        or not tab_groups.instance_is_online(browser_instance_id)
    ):
        raise HTTPException(status_code=409, detail="来源浏览器未连接或仍在同步标签组")

    command_id = tab_groups.create_command(
        browser_instance_id=browser_instance_id,
        archive_id=archive_id,
        kind="restore",
        target=req.target,
        payload=tab_groups.archive_to_command_payload(archive),
    )
    try:
        await _send_pending(browser_instance_id, websocket, current_session_id, True)
    except (RuntimeError, WebSocketDisconnect):
        async with _connections_lock:
            if _connections.get(browser_instance_id) is websocket:
                _connections.pop(browser_instance_id, None)
                _sessions.pop(browser_instance_id, None)
                _ready_instances.discard(browser_instance_id)
                _complete_instances.discard(browser_instance_id)
        tab_groups.mark_instance_offline(browser_instance_id)
    return TabGroupCommandResponse(commandId=command_id, status="queued")


@router.delete(
    "/{archive_id}",
    response_model=TabGroupDeleteResponse,
    dependencies=[Depends(require_api_token)],
)
async def delete_tab_group(archive_id: str) -> TabGroupDeleteResponse:
    deleted, status, command_id = tab_groups.delete_archive(archive_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="标签归档不存在")
    if command_id:
        browser_instance_id = tab_groups.browser_instance_id_for_command(command_id)
        if browser_instance_id:
            async with _connections_lock:
                websocket = _connections.get(browser_instance_id)
                current_session_id = _sessions.get(browser_instance_id, "")
                is_ready = browser_instance_id in _ready_instances
                inventory_complete = browser_instance_id in _complete_instances
            if websocket and is_ready:
                try:
                    await _send_pending(
                        browser_instance_id,
                        websocket,
                        current_session_id,
                        inventory_complete,
                    )
                except (RuntimeError, WebSocketDisconnect):
                    async with _connections_lock:
                        if _connections.get(browser_instance_id) is websocket:
                            _connections.pop(browser_instance_id, None)
                            _sessions.pop(browser_instance_id, None)
                            _ready_instances.discard(browser_instance_id)
                            _complete_instances.discard(browser_instance_id)
                    tab_groups.mark_instance_offline(browser_instance_id)
    return TabGroupDeleteResponse(
        deleted=True,
        status=status or "deleted",
        commandId=command_id,
    )


@router.websocket("/bridge")
async def tab_group_bridge(
    websocket: WebSocket,
    browser_instance_id: str = Query(alias="browserInstanceId", min_length=1, max_length=128),
) -> None:
    await websocket.accept()
    registered = False
    browser = "chrome"
    session_id = "unknown"
    try:
        try:
            auth = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        except (asyncio.TimeoutError, ValueError):
            await websocket.close(code=4401)
            return
        if not isinstance(auth, dict) or auth.get("type") != "authenticate":
            await websocket.close(code=4401)
            return
        token = auth.get("token")
        expected = storage.get_api_token()
        if not is_auth_disabled() and (not expected or token != expected):
            await websocket.close(code=4401)
            return
        if auth.get("browserInstanceId") != browser_instance_id:
            await websocket.close(code=4400)
            return
        browser_value = auth.get("browser")
        if browser_value not in {"chrome", "edge"}:
            await websocket.close(code=4400)
            return
        browser = str(browser_value)
        session_id = str(auth.get("browserSessionId", ""))
        if not session_id or len(session_id) > 128:
            await websocket.close(code=4400)
            return

        async with _connections_lock:
            previous = _connections.get(browser_instance_id)
            _connections[browser_instance_id] = websocket
            _sessions[browser_instance_id] = session_id
            _ready_instances.discard(browser_instance_id)
            _complete_instances.discard(browser_instance_id)
        if previous and previous is not websocket:
            try:
                await previous.close(code=4001)
            except RuntimeError:
                pass
        tab_groups.set_instance_state(browser_instance_id, browser, session_id, True)
        registered = True
        await websocket.send_json({"type": "connected"})

        while True:
            message: Any = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            message_type = message.get("type")
            if message_type == "ready":
                inventory_complete = message.get("complete") is not False
                is_current_connection = False
                async with _connections_lock:
                    if _connections.get(browser_instance_id) is websocket:
                        is_current_connection = True
                        _ready_instances.add(browser_instance_id)
                        if inventory_complete:
                            _complete_instances.add(browser_instance_id)
                        else:
                            _complete_instances.discard(browser_instance_id)
                if not is_current_connection:
                    continue
                tab_groups.set_instance_inventory_complete(
                    browser_instance_id,
                    inventory_complete,
                )
                await _send_pending(
                    browser_instance_id,
                    websocket,
                    session_id,
                    inventory_complete,
                )
            elif message_type == "heartbeat":
                tab_groups.touch_instance(browser_instance_id)
                await websocket.send_json({"type": "heartbeat_ack"})
            elif message_type == "command_result":
                command_id = message.get("commandId")
                ok = message.get("ok") is True
                if isinstance(command_id, str):
                    accepted = tab_groups.complete_command(
                        command_id,
                        browser_instance_id=browser_instance_id,
                        ok=ok,
                        error=str(message.get("error", "")) or None,
                    )
                    await websocket.send_json(
                        {"type": "command_ack", "commandId": command_id, "accepted": accepted}
                    )
    except WebSocketDisconnect:
        pass
    finally:
        if registered:
            async with _connections_lock:
                if _connections.get(browser_instance_id) is websocket:
                    _connections.pop(browser_instance_id, None)
                    _sessions.pop(browser_instance_id, None)
                    _ready_instances.discard(browser_instance_id)
                    _complete_instances.discard(browser_instance_id)
                    tab_groups.mark_instance_offline(browser_instance_id)
