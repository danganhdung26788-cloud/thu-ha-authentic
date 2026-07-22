"""Send prepared Thu Hà Authentic replies through Meta Messenger Send API.

No confidence threshold is imposed. Any DRAFT_READY row may be sent when the
operator explicitly enables NATURAL_AUTO_REPLY. NEED_HUMAN remains an internal
handoff signal and does not prevent a brief handoff response from being sent.
"""
from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone
from typing import Any

import requests

from integrations.hermes.fanpage_draft_processor import rows_to_dicts

FAST_INDEX_ID = os.getenv(
    "THA_HERMES_FAST_INDEX_ID",
    "1ZACaor_QW1sQX35S-_PpqjcyX02iiSQPImYCHhaUIf0",
)
PAGE_ID = os.getenv("THA_META_PAGE_ID", "108621404211232")
PAGE_ACCESS_TOKEN = os.getenv("META_PAGE_ACCESS_TOKEN", "").strip()
GRAPH_VERSION = os.getenv("META_GRAPH_API_VERSION", "v25.0").strip()
REPLY_MODE = os.getenv("THA_REPLY_MODE", "DRAFT_ONLY").strip().upper()
AUTO_SEND = os.getenv("THA_META_AUTO_SEND", "false").strip().lower() == "true"
MAX_ITEMS = max(1, min(int(os.getenv("THA_META_SEND_MAX_ITEMS", "10")), 50))
REQUEST_TIMEOUT = max(5, min(int(os.getenv("THA_META_SEND_TIMEOUT_SECONDS", "30")), 120))


class MetaSendError(RuntimeError):
    pass


class MetaClient:
    def __init__(
        self,
        page_id: str,
        access_token: str,
        graph_version: str = GRAPH_VERSION,
        session: requests.Session | None = None,
    ) -> None:
        if not page_id:
            raise ValueError("Meta Page ID is required")
        if not access_token:
            raise ValueError("Meta Page Access Token is required")
        self.page_id = page_id
        self.access_token = access_token
        self.graph_version = graph_version
        self.session = session or requests.Session()
        self.base_url = f"https://graph.facebook.com/{graph_version}"

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    def verify_page(self) -> dict[str, Any]:
        response = self.session.get(
            f"{self.base_url}/{self.page_id}",
            params={"fields": "id,name"},
            headers=self.headers,
            timeout=REQUEST_TIMEOUT,
        )
        payload = self._payload(response)
        if str(payload.get("id", "")) != self.page_id:
            raise MetaSendError("Page token verification returned a different Page ID")
        return payload

    def send_text(self, recipient_id: str, text: str) -> dict[str, Any]:
        if not recipient_id:
            raise ValueError("Recipient PSID is required")
        text = (text or "").strip()
        if not text:
            raise ValueError("Reply text is empty")
        response = self.session.post(
            f"{self.base_url}/{self.page_id}/messages",
            headers={**self.headers, "Content-Type": "application/json"},
            json={
                "recipient": {"id": recipient_id},
                "messaging_type": "RESPONSE",
                "message": {"text": text[:2000]},
            },
            timeout=REQUEST_TIMEOUT,
        )
        payload = self._payload(response)
        if not payload.get("message_id"):
            raise MetaSendError("Meta response did not include message_id")
        return payload

    @staticmethod
    def _payload(response: requests.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except ValueError as exc:
            raise MetaSendError(f"Meta returned non-JSON HTTP {response.status_code}") from exc
        if response.status_code >= 400 or "error" in payload:
            error = payload.get("error", {})
            code = error.get("code", "unknown") if isinstance(error, dict) else "unknown"
            message = error.get("message", "Meta API request failed") if isinstance(error, dict) else str(error)
            raise MetaSendError(f"Meta API error code={code}: {message}")
        return payload


class SheetsRepository:
    def __init__(self, spreadsheet_id: str) -> None:
        from google.auth import default as google_auth_default
        from googleapiclient.discovery import build

        credentials, _ = google_auth_default(
            scopes=["https://www.googleapis.com/auth/spreadsheets"]
        )
        self.service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
        self.spreadsheet_id = spreadsheet_id

    def read_queue(self) -> list[dict[str, str]]:
        result = self.service.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id,
            range="FANPAGE_QUEUE!A1:M2000",
        ).execute()
        return rows_to_dicts(result.get("values", []))

    def set_status(
        self,
        row_number: int,
        status: str,
        replied_at: str = "",
        error: str = "",
    ) -> None:
        self.service.spreadsheets().values().batchUpdate(
            spreadsheetId=self.spreadsheet_id,
            body={
                "valueInputOption": "RAW",
                "data": [
                    {"range": f"FANPAGE_QUEUE!J{row_number}", "values": [[status]]},
                    {"range": f"FANPAGE_QUEUE!L{row_number}", "values": [[replied_at]]},
                    {"range": f"FANPAGE_QUEUE!M{row_number}", "values": [[error]]},
                ],
            },
        ).execute()


def send_ready_messages(repo: SheetsRepository, client: MetaClient) -> tuple[int, int, int]:
    eligible = sent = failed = 0
    for row_number, row in enumerate(repo.read_queue(), start=2):
        if str(row.get("STATUS", "")).strip().upper() != "DRAFT_READY":
            continue
        eligible += 1
        recipient_id = str(row.get("CUSTOMER_ID", "")).strip()
        reply = str(row.get("DRAFT_REPLY", "")).strip()
        repo.set_status(row_number, "SENDING")
        try:
            client.send_text(recipient_id, reply)
            replied_at = datetime.now(timezone.utc).isoformat()
            repo.set_status(row_number, "SENT", replied_at=replied_at)
            sent += 1
        except (MetaSendError, ValueError, requests.RequestException) as exc:
            repo.set_status(row_number, "SEND_FAILED", error=str(exc)[:500])
            failed += 1
        if sent + failed >= MAX_ITEMS:
            break
    return eligible, sent, failed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-token", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not PAGE_ACCESS_TOKEN:
        print("SKIP Meta outbound sender: META_PAGE_ACCESS_TOKEN is missing")
        return 0 if not args.verify_token else 1

    client = MetaClient(PAGE_ID, PAGE_ACCESS_TOKEN)
    if args.verify_token:
        page = client.verify_page()
        print(f"PASS Meta Page token verified page_id={page.get('id')} page_name={page.get('name', '')}")
        return 0

    if REPLY_MODE != "NATURAL_AUTO_REPLY" or not AUTO_SEND:
        print(
            "SKIP Meta outbound sender: "
            f"reply_mode={REPLY_MODE} auto_send={str(AUTO_SEND).upper()}"
        )
        return 0

    repo = SheetsRepository(FAST_INDEX_ID)
    eligible, sent, failed = send_ready_messages(repo, client)
    print(
        "PASS Meta outbound sender "
        f"eligible={eligible} sent={sent} failed={failed} mode={REPLY_MODE}"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
