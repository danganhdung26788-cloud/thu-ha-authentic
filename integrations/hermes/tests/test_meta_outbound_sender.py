from __future__ import annotations

import unittest
from unittest.mock import Mock

from integrations.hermes.meta_outbound_sender import MetaClient, MetaSendError, send_ready_messages


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class FakeRepo:
    def __init__(self):
        self.statuses = []

    def read_queue(self):
        return [
            {
                "CUSTOMER_ID": "psid-1",
                "DRAFT_REPLY": "Dạ shop còn hàng chị nhé.",
                "STATUS": "DRAFT_READY",
            },
            {
                "CUSTOMER_ID": "psid-2",
                "DRAFT_REPLY": "Không gửi lại",
                "STATUS": "SENT",
            },
        ]

    def set_status(self, row_number, status, replied_at="", error=""):
        self.statuses.append((row_number, status, replied_at, error))


class MetaOutboundSenderTests(unittest.TestCase):
    def test_verify_page_token_uses_me_identity(self):
        session = Mock()
        session.get.return_value = FakeResponse(200, {"id": "page-1", "name": "Thu Hà"})
        client = MetaClient("page-1", "token", session=session)
        page = client.verify_page()
        self.assertEqual(page["id"], "page-1")
        self.assertTrue(session.get.call_args.args[0].endswith("/me"))
        self.assertEqual(session.get.call_args.kwargs["params"], {"fields": "id,name"})
        self.assertIn("Bearer token", session.get.call_args.kwargs["headers"]["Authorization"])

    def test_meta_client_trims_identifiers_before_requests(self):
        session = Mock()
        session.get.return_value = FakeResponse(200, {"id": "page-1", "name": "Thu Hà"})
        client = MetaClient(" page-1\r\n", " token-value\n", graph_version=" v25.0\r\n", session=session)
        page = client.verify_page()
        self.assertEqual(page["id"], "page-1")
        self.assertEqual(client.page_id, "page-1")
        self.assertEqual(client.access_token, "token-value")
        self.assertEqual(client.graph_version, "v25.0")
        self.assertEqual(session.get.call_args.args[0], "https://graph.facebook.com/v25.0/me")

    def test_verify_page_token_rejects_wrong_identity_with_clear_ids(self):
        session = Mock()
        session.get.return_value = FakeResponse(200, {"id": "other-page", "name": "Other Page"})
        secret = "super-secret-token-value"
        client = MetaClient("page-1", secret, session=session)
        with self.assertRaises(MetaSendError) as context:
            client.verify_page()
        message = str(context.exception)
        self.assertIn("expected_page_id=page-1", message)
        self.assertIn("actual_id=other-page", message)
        self.assertNotIn(secret, message)

    def test_send_text_uses_response_message_type(self):
        session = Mock()
        session.post.return_value = FakeResponse(200, {"recipient_id": "psid-1", "message_id": "mid-1"})
        client = MetaClient("page-1", "token", session=session)
        result = client.send_text("psid-1", "Xin chào")
        self.assertEqual(result["message_id"], "mid-1")
        payload = session.post.call_args.kwargs["json"]
        self.assertEqual(payload["messaging_type"], "RESPONSE")
        self.assertEqual(payload["recipient"]["id"], "psid-1")

    def test_api_error_is_sanitized(self):
        session = Mock()
        session.post.return_value = FakeResponse(
            400, {"error": {"code": 190, "message": "Invalid OAuth access token"}}
        )
        client = MetaClient("page-1", "secret-token", session=session)
        with self.assertRaises(MetaSendError) as context:
            client.send_text("psid-1", "Xin chào")
        self.assertNotIn("secret-token", str(context.exception))
        self.assertIn("code=190", str(context.exception))

    def test_send_ready_messages_claims_and_marks_sent(self):
        repo = FakeRepo()
        client = Mock()
        client.send_text.return_value = {"message_id": "mid-1"}
        eligible, sent, failed = send_ready_messages(repo, client)
        self.assertEqual((eligible, sent, failed), (1, 1, 0))
        self.assertEqual(repo.statuses[0][1], "SENDING")
        self.assertEqual(repo.statuses[1][1], "SENT")
        self.assertTrue(repo.statuses[1][2])

    def test_send_failure_is_recorded(self):
        repo = FakeRepo()
        client = Mock()
        client.send_text.side_effect = MetaSendError("permission denied")
        eligible, sent, failed = send_ready_messages(repo, client)
        self.assertEqual((eligible, sent, failed), (1, 0, 1))
        self.assertEqual(repo.statuses[-1][1], "SEND_FAILED")
        self.assertIn("permission denied", repo.statuses[-1][3])


if __name__ == "__main__":
    unittest.main()
