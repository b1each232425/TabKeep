import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from main import app
from services import tab_groups
from tests.helpers import IsolatedBackendState


class TabGroupsApiTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = IsolatedBackendState(f"tab-groups-{self._testMethodName}")
        self.workspace.setup()
        self.client = TestClient(app)
        self.token = "tab-groups-test-token"
        self.headers = {"X-TabKeep-Token": self.token}
        configured = self.client.post("/config/sync", json={"apiToken": self.token})
        self.assertEqual(configured.status_code, 200, configured.text)

    def tearDown(self) -> None:
        self.client.close()
        self.workspace.teardown()

    @staticmethod
    def group_snapshot(
        *,
        native_group_id: int = 8,
        title: str = "调研",
        tabs: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        return {
            "nativeGroupId": native_group_id,
            "title": title,
            "color": "blue",
            "collapsed": False,
            "windowId": 4,
            "tabs": tabs
            or [
                {
                    "url": "https://example.test/one",
                    "title": "资料一",
                    "favIconUrl": "https://example.test/favicon.ico",
                    "index": 2,
                    "active": False,
                },
                {
                    "url": "https://example.test/two",
                    "title": "资料二",
                    "index": 3,
                    "active": True,
                },
            ],
        }

    def snapshot_payload(
        self,
        *,
        instance_id: str = "chrome-profile-a",
        browser: str = "chrome",
        session_id: str = "session-a",
        complete: bool = True,
        groups: list[dict[str, object]] | None = None,
    ) -> dict[str, object]:
        return {
            "browserInstanceId": instance_id,
            "browser": browser,
            "browserSessionId": session_id,
            "complete": complete,
            "groups": groups if groups is not None else [self.group_snapshot()],
        }

    def test_group_changes_update_persistent_record_and_group_close_keeps_last_snapshot(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        archive_id = saved.json()["assignments"][0]["archiveId"]

        updated_group = self.group_snapshot(
            title="调研第二版",
            tabs=[
                {
                    "url": "https://example.test/updated",
                    "title": "更新后的资料",
                    "index": 1,
                    "active": True,
                }
            ],
        )
        updated = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[updated_group]),
            headers=self.headers,
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["assignments"][0]["archiveId"], archive_id)

        closed = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[]),
            headers=self.headers,
        )
        self.assertEqual(closed.status_code, 200, closed.text)

        listing = self.client.get("/tab-groups", headers=self.headers)
        self.assertEqual(listing.status_code, 200, listing.text)
        items = listing.json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], archive_id)
        self.assertEqual(items[0]["title"], "调研第二版")
        self.assertFalse(items[0]["isOpen"])
        self.assertEqual(items[0]["tabs"][0]["url"], "https://example.test/updated")

    def test_incomplete_snapshot_does_not_overwrite_a_saved_archive(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]
        partial_group = self.group_snapshot(
            native_group_id=21,
            title="部分加载",
            tabs=[
                {
                    "url": "https://example.test/partial",
                    "title": "加载中的标签",
                    "index": 1,
                }
            ],
        )
        partial = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(
                session_id="session-b",
                complete=False,
                groups=[partial_group],
            ),
            headers=self.headers,
        )
        self.assertEqual(partial.status_code, 200, partial.text)
        self.assertIsNone(partial.json()["assignments"][0]["archiveId"])

        archive = self.client.get("/tab-groups", headers=self.headers).json()["items"][0]
        self.assertEqual(archive["id"], archive_id)
        self.assertEqual(archive["title"], "调研")
        self.assertEqual(archive["tabs"][0]["url"], "https://example.test/one")

    def test_non_restorable_live_group_keeps_last_archive_snapshot_open(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]
        self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[]),
            headers=self.headers,
        )
        self.assertFalse(
            self.client.get("/tab-groups", headers=self.headers).json()["items"][0]["isOpen"]
        )
        unsupported_group = self.group_snapshot(
            tabs=[
                {
                    "url": "chrome://settings",
                    "title": "浏览器设置",
                    "index": 2,
                }
            ]
        )
        unsupported_group["archiveId"] = archive_id
        updated = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[unsupported_group]),
            headers=self.headers,
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["assignments"][0]["archiveId"], archive_id)
        archive = self.client.get("/tab-groups", headers=self.headers).json()["items"][0]
        self.assertTrue(archive["isOpen"])
        self.assertEqual(archive["tabs"][0]["url"], "https://example.test/one")

    def test_new_group_does_not_reuse_a_closed_archive_with_the_same_fingerprint(self) -> None:
        first = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        first_archive_id = first.json()["assignments"][0]["archiveId"]
        closed = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[]),
            headers=self.headers,
        )
        self.assertEqual(closed.status_code, 200, closed.text)

        second = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(
                session_id="session-b",
                groups=[self.group_snapshot(native_group_id=19)],
            ),
            headers=self.headers,
        )
        self.assertEqual(second.status_code, 200, second.text)
        second_archive_id = second.json()["assignments"][0]["archiveId"]
        self.assertNotEqual(first_archive_id, second_archive_id)
        self.assertEqual(len(self.client.get("/tab-groups", headers=self.headers).json()["items"]), 2)

    def test_open_group_is_reassociated_after_browser_session_restart(self) -> None:
        first = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = first.json()["assignments"][0]["archiveId"]

        restarted = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(
                session_id="session-b",
                groups=[self.group_snapshot(native_group_id=21)],
            ),
            headers=self.headers,
        )
        self.assertEqual(restarted.status_code, 200, restarted.text)
        self.assertEqual(restarted.json()["assignments"][0]["archiveId"], archive_id)

    def test_empty_startup_snapshot_does_not_close_previous_session_archive(self) -> None:
        first = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = first.json()["assignments"][0]["archiveId"]

        empty_startup = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(session_id="session-b", complete=False, groups=[]),
            headers=self.headers,
        )
        self.assertEqual(empty_startup.status_code, 200, empty_startup.text)
        self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(session_id="session-b", complete=False, groups=[]),
            headers=self.headers,
        )

        restored = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(
                session_id="session-b",
                groups=[self.group_snapshot(native_group_id=21)],
            ),
            headers=self.headers,
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json()["assignments"][0]["archiveId"], archive_id)
        self.assertEqual(len(self.client.get("/tab-groups", headers=self.headers).json()["items"]), 1)

    def test_same_native_group_id_from_two_browser_instances_stays_separate(self) -> None:
        chrome = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        edge = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(
                instance_id="edge-profile-a",
                browser="edge",
                session_id="edge-session-a",
            ),
            headers=self.headers,
        )

        self.assertEqual(chrome.status_code, 200, chrome.text)
        self.assertEqual(edge.status_code, 200, edge.text)
        listing = self.client.get("/tab-groups", headers=self.headers)
        self.assertEqual(len(listing.json()["items"]), 2)
        self.assertEqual(
            {item["browser"] for item in listing.json()["items"]}, {"chrome", "edge"}
        )

    def test_deleting_one_of_two_identical_groups_does_not_suppress_the_other(self) -> None:
        first = self.group_snapshot(native_group_id=8)
        second = self.group_snapshot(native_group_id=9)
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[first, second]),
            headers=self.headers,
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        first_archive_id = saved.json()["assignments"][0]["archiveId"]
        self.assertNotEqual(first_archive_id, saved.json()["assignments"][1]["archiveId"])

        deleted = self.client.delete(
            f"/tab-groups/{first_archive_id}",
            headers=self.headers,
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)

        remaining = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[second]),
            headers=self.headers,
        )
        self.assertEqual(remaining.status_code, 200, remaining.text)
        self.assertIsNotNone(remaining.json()["assignments"][0]["archiveId"])
        listing = self.client.get("/tab-groups", headers=self.headers)
        self.assertEqual(len(listing.json()["items"]), 1)

    def test_snapshot_endpoint_requires_local_api_token(self) -> None:
        response = self.client.post("/tab-groups/snapshot", json=self.snapshot_payload())
        self.assertEqual(response.status_code, 401)

    def test_restore_is_rejected_when_source_browser_is_offline(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]

        response = self.client.post(
            f"/tab-groups/{archive_id}/restore",
            json={"target": "current"},
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 409)

    def test_restore_command_is_delivered_after_browser_snapshot_handshake(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]

        with self.client.websocket_connect("/tab-groups/bridge?browserInstanceId=chrome-profile-a") as ws:
            ws.send_json(
                {
                    "type": "authenticate",
                    "token": self.token,
                    "browserInstanceId": "chrome-profile-a",
                    "browser": "chrome",
                    "browserSessionId": "session-a",
                }
            )
            self.assertEqual(ws.receive_json()["type"], "connected")
            ws.send_json({"type": "ready"})

            response = self.client.post(
                f"/tab-groups/{archive_id}/restore",
                json={"target": "new"},
                headers=self.headers,
            )
            self.assertEqual(response.status_code, 202, response.text)
            command_message = ws.receive_json()
            command = command_message["command"]
            self.assertEqual(command_message["type"], "command")
            self.assertEqual(command["kind"], "restore")
            self.assertEqual(command["target"], "new")
            self.assertEqual(command["archiveId"], archive_id)
            self.assertEqual(command["payload"]["tabs"][0]["url"], "https://example.test/one")
            ws.send_json(
                {
                    "type": "command_result",
                    "commandId": command["id"],
                    "ok": True,
                }
            )
            self.assertEqual(ws.receive_json()["type"], "command_ack")

    def test_restarted_group_keeps_archive_link_for_pending_restore(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]
        self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[]),
            headers=self.headers,
        )

        with self.client.websocket_connect("/tab-groups/bridge?browserInstanceId=chrome-profile-a") as ws:
            ws.send_json(
                {
                    "type": "authenticate",
                    "token": self.token,
                    "browserInstanceId": "chrome-profile-a",
                    "browser": "chrome",
                    "browserSessionId": "session-a",
                }
            )
            self.assertEqual(ws.receive_json()["type"], "connected")
            ws.send_json({"type": "ready", "complete": True})
            restore = self.client.post(
                f"/tab-groups/{archive_id}/restore",
                json={"target": "new"},
                headers=self.headers,
            )
            self.assertEqual(restore.status_code, 202, restore.text)
            self.assertEqual(ws.receive_json()["command"]["kind"], "restore")

        restarted_group = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(
                session_id="session-b",
                groups=[self.group_snapshot(native_group_id=21)],
            ),
            headers=self.headers,
        )
        self.assertEqual(restarted_group.status_code, 200, restarted_group.text)
        self.assertEqual(restarted_group.json()["assignments"][0]["archiveId"], archive_id)

    def test_incomplete_inventory_allows_same_session_delete_but_blocks_restore(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]

        with self.client.websocket_connect("/tab-groups/bridge?browserInstanceId=chrome-profile-a") as ws:
            ws.send_json(
                {
                    "type": "authenticate",
                    "token": self.token,
                    "browserInstanceId": "chrome-profile-a",
                    "browser": "chrome",
                    "browserSessionId": "session-a",
                }
            )
            self.assertEqual(ws.receive_json()["type"], "connected")
            ws.send_json({"type": "ready", "complete": False})

            stale_snapshot = self.client.post(
                "/tab-groups/snapshot",
                json=self.snapshot_payload(session_id="session-b", groups=[]),
                headers=self.headers,
            )
            self.assertEqual(stale_snapshot.status_code, 409)

            restore = self.client.post(
                f"/tab-groups/{archive_id}/restore",
                json={"target": "current"},
                headers=self.headers,
            )
            self.assertEqual(restore.status_code, 409)
            archive = self.client.get("/tab-groups", headers=self.headers).json()["items"][0]
            self.assertTrue(archive["browserOnline"])
            self.assertFalse(archive["browserReady"])

            ws.send_json({"type": "ready", "complete": True})
            archive = self.client.get("/tab-groups", headers=self.headers).json()["items"][0]
            self.assertTrue(archive["browserReady"])

            deleted = self.client.delete(f"/tab-groups/{archive_id}", headers=self.headers)
            self.assertEqual(deleted.status_code, 200, deleted.text)
            command = ws.receive_json()["command"]
            self.assertEqual(command["kind"], "delete")
            self.assertEqual(command["payload"]["browserSessionId"], "session-a")

    def test_restart_delete_waits_for_complete_inventory(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]
        deleted = self.client.delete(f"/tab-groups/{archive_id}", headers=self.headers)
        self.assertEqual(deleted.status_code, 200, deleted.text)

        with self.client.websocket_connect("/tab-groups/bridge?browserInstanceId=chrome-profile-a") as ws:
            ws.send_json(
                {
                    "type": "authenticate",
                    "token": self.token,
                    "browserInstanceId": "chrome-profile-a",
                    "browser": "chrome",
                    "browserSessionId": "session-b",
                }
            )
            self.assertEqual(ws.receive_json()["type"], "connected")
            ws.send_json({"type": "ready", "complete": False})
            self.assertEqual(
                tab_groups.pending_commands(
                    "chrome-profile-a",
                    browser_session_id="session-b",
                    inventory_complete=False,
                ),
                [],
            )
            self.assertEqual(
                len(tab_groups.pending_commands("chrome-profile-a", inventory_complete=True)),
                1,
            )

            ws.send_json({"type": "ready", "complete": True})
            command = ws.receive_json()["command"]
            self.assertEqual(command["kind"], "delete")

    def test_delete_removes_archive_and_queues_live_group_close_for_reconnect(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]

        deleted = self.client.delete(f"/tab-groups/{archive_id}", headers=self.headers)
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(deleted.json()["status"], "queued")
        listing = self.client.get("/tab-groups", headers=self.headers)
        self.assertEqual(listing.json()["items"], [])

        still_open_group = self.group_snapshot()
        still_open_group["archiveId"] = archive_id
        sync_after_delete = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[still_open_group]),
            headers=self.headers,
        )
        self.assertEqual(sync_after_delete.status_code, 200, sync_after_delete.text)
        self.assertTrue(sync_after_delete.json()["assignments"][0]["suppressed"])
        self.assertEqual(self.client.get("/tab-groups", headers=self.headers).json()["items"], [])

        with self.client.websocket_connect("/tab-groups/bridge?browserInstanceId=chrome-profile-a") as ws:
            ws.send_json(
                {
                    "type": "authenticate",
                    "token": self.token,
                    "browserInstanceId": "chrome-profile-a",
                    "browser": "chrome",
                    "browserSessionId": "session-a",
                }
            )
            self.assertEqual(ws.receive_json()["type"], "connected")
            ws.send_json({"type": "ready"})
            command = ws.receive_json()
            self.assertEqual(command["type"], "command")
            self.assertEqual(command["command"]["kind"], "delete")
            self.assertEqual(command["command"]["archiveId"], archive_id)
            ws.send_json(
                {
                    "type": "command_result",
                    "commandId": command["command"]["id"],
                    "ok": True,
                }
            )
            self.assertEqual(ws.receive_json()["type"], "command_ack")

    def test_delete_cancels_pending_restore_and_queues_close_even_if_archive_was_closed(self) -> None:
        self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(groups=[]),
            headers=self.headers,
        )
        archive = self.client.get("/tab-groups", headers=self.headers).json()["items"][0]
        archive_id = archive["id"]

        with self.client.websocket_connect("/tab-groups/bridge?browserInstanceId=chrome-profile-a") as ws:
            ws.send_json(
                {
                    "type": "authenticate",
                    "token": self.token,
                    "browserInstanceId": "chrome-profile-a",
                    "browser": "chrome",
                    "browserSessionId": "session-a",
                }
            )
            self.assertEqual(ws.receive_json()["type"], "connected")
            ws.send_json({"type": "ready"})

            restore = self.client.post(
                f"/tab-groups/{archive_id}/restore",
                json={"target": "current"},
                headers=self.headers,
            )
            self.assertEqual(restore.status_code, 202, restore.text)
            restore_command = ws.receive_json()["command"]
            self.assertEqual(restore_command["kind"], "restore")

            deleted = self.client.delete(f"/tab-groups/{archive_id}", headers=self.headers)
            self.assertEqual(deleted.status_code, 200, deleted.text)
            self.assertEqual(deleted.json()["status"], "queued")
            self.assertFalse(
                tab_groups.complete_command(
                    restore_command["id"],
                    browser_instance_id="chrome-profile-a",
                    ok=True,
                )
            )
            delete_command = ws.receive_json()["command"]
            self.assertEqual(delete_command["kind"], "delete")
            self.assertEqual(
                [command["kind"] for command in tab_groups.pending_commands("chrome-profile-a")],
                ["delete"],
            )

    def test_unique_restart_group_is_reassociated_with_pending_delete(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]
        deleted = self.client.delete(f"/tab-groups/{archive_id}", headers=self.headers)
        self.assertEqual(deleted.status_code, 200, deleted.text)

        empty_startup = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(session_id="session-b", complete=False, groups=[]),
            headers=self.headers,
        )
        self.assertEqual(empty_startup.status_code, 200, empty_startup.text)
        incomplete_group = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(
                session_id="session-b",
                complete=False,
                groups=[self.group_snapshot(native_group_id=21)],
            ),
            headers=self.headers,
        )
        self.assertIsNone(incomplete_group.json()["assignments"][0]["archiveId"])
        self.assertFalse(incomplete_group.json()["assignments"][0]["suppressed"])

        settled_group = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(
                session_id="session-b",
                groups=[self.group_snapshot(native_group_id=21)],
            ),
            headers=self.headers,
        )
        self.assertEqual(settled_group.status_code, 200, settled_group.text)
        self.assertTrue(settled_group.json()["assignments"][0]["suppressed"])
        self.assertIsNone(settled_group.json()["assignments"][0]["archiveId"])
        self.assertEqual(self.client.get("/tab-groups", headers=self.headers).json()["items"], [])
        self.assertEqual(
            [command["kind"] for command in tab_groups.pending_commands("chrome-profile-a")],
            ["delete"],
        )

    def test_ambiguous_restart_match_does_not_suppress_any_group(self) -> None:
        saved = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(),
            headers=self.headers,
        )
        archive_id = saved.json()["assignments"][0]["archiveId"]
        deleted = self.client.delete(f"/tab-groups/{archive_id}", headers=self.headers)
        self.assertEqual(deleted.status_code, 200, deleted.text)

        first = self.group_snapshot(native_group_id=21)
        second = self.group_snapshot(native_group_id=22)
        restarted = self.client.post(
            "/tab-groups/snapshot",
            json=self.snapshot_payload(session_id="session-b", groups=[first, second]),
            headers=self.headers,
        )
        self.assertEqual(restarted.status_code, 200, restarted.text)
        assignments = restarted.json()["assignments"]
        self.assertEqual(len(assignments), 2)
        self.assertTrue(all(not assignment["suppressed"] for assignment in assignments))
        self.assertNotEqual(assignments[0]["archiveId"], assignments[1]["archiveId"])
        self.assertEqual(len(self.client.get("/tab-groups", headers=self.headers).json()["items"]), 2)


if __name__ == "__main__":
    unittest.main()
