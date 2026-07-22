"""Record supervised corrections for the Thu Hà Authentic cosmetics skill."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from integrations.hermes.fanpage_draft_processor import rows_to_dicts

FAST_INDEX_ID = os.getenv(
    "THA_HERMES_FAST_INDEX_ID",
    "1ZACaor_QW1sQX35S-_PpqjcyX02iiSQPImYCHhaUIf0",
)
TRAINING_ROOT = Path(
    os.getenv(
        "THA_COSMETICS_TRAINING_PATH",
        "/opt/data/training/thu-ha-cosmetics",
    )
)
APPROVED_TRAINERS = {
    "NONG_THU_HA": "Nông Thu Hà",
    "DANG_ANH_DUNG": "Đặng Anh Dũng",
}


@dataclass(frozen=True)
class TrainingCorrection:
    correction_id: str
    version: str
    status: str
    trainer: str
    created_at: str
    message_id: str
    customer_message: str
    original_reply: str
    corrected_reply: str
    reason: str
    intent: str
    product_key: str
    previous_version: str


class SheetsRepository:
    def __init__(self, spreadsheet_id: str) -> None:
        from google.auth import default as google_auth_default
        from googleapiclient.discovery import build

        credentials, _ = google_auth_default(
            scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"]
        )
        self.service = build("sheets", "v4", credentials=credentials, cache_discovery=False)
        self.spreadsheet_id = spreadsheet_id

    def read_queue(self) -> list[dict[str, str]]:
        result = self.service.spreadsheets().values().get(
            spreadsheetId=self.spreadsheet_id,
            range="FANPAGE_QUEUE!A1:M2000",
        ).execute()
        return rows_to_dicts(result.get("values", []))


def normalize_trainer(value: str) -> str:
    key = "_".join((value or "").strip().upper().split())
    if key in APPROVED_TRAINERS:
        return APPROVED_TRAINERS[key]
    for canonical in APPROVED_TRAINERS.values():
        if value.strip().casefold() == canonical.casefold():
            return canonical
    raise ValueError("Trainer must be NONG_THU_HA or DANG_ANH_DUNG")


def find_message(rows: list[dict[str, str]], message_id: str) -> dict[str, str]:
    matches = [row for row in rows if str(row.get("MESSAGE_ID", "")).strip() == message_id]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one queue row for MESSAGE_ID={message_id}; found {len(matches)}")
    return matches[0]


def next_version(root: Path) -> tuple[str, str]:
    versions = sorted((root / "pending").glob("*.json")) + sorted((root / "approved").glob("*.json"))
    previous = ""
    maximum = 0
    for path in versions:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            version = str(payload.get("version", ""))
            if version.startswith("training-v"):
                maximum = max(maximum, int(version.removeprefix("training-v")))
                previous = version if int(version.removeprefix("training-v")) == maximum else previous
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return f"training-v{maximum + 1:04d}", previous


def record_correction(
    row: dict[str, str],
    corrected_reply: str,
    reason: str,
    trainer: str,
    root: Path = TRAINING_ROOT,
) -> TrainingCorrection:
    trainer = normalize_trainer(trainer)
    corrected_reply = corrected_reply.strip()
    reason = reason.strip()
    if not corrected_reply:
        raise ValueError("Corrected reply must not be empty")
    if not reason:
        raise ValueError("Reason must not be empty")

    pending = root / "pending"
    approved = root / "approved"
    rejected = root / "rejected"
    versions = root / "versions"
    for directory in (pending, approved, rejected, versions):
        directory.mkdir(parents=True, exist_ok=True)

    version, previous = next_version(root)
    created_at = datetime.now(timezone.utc).isoformat()
    digest_input = "|".join(
        [row.get("MESSAGE_ID", ""), corrected_reply, trainer, created_at]
    ).encode("utf-8")
    correction_id = "tha-train-" + hashlib.sha256(digest_input).hexdigest()[:16]
    correction = TrainingCorrection(
        correction_id=correction_id,
        version=version,
        status="PENDING",
        trainer=trainer,
        created_at=created_at,
        message_id=str(row.get("MESSAGE_ID", "")),
        customer_message=str(row.get("MESSAGE_TEXT", "")),
        original_reply=str(row.get("DRAFT_REPLY", "")),
        corrected_reply=corrected_reply,
        reason=reason,
        intent=str(row.get("INTENT", "")),
        product_key=str(row.get("PRODUCT_KEY", "")),
        previous_version=previous,
    )
    payload = json.dumps(asdict(correction), ensure_ascii=False, indent=2) + "\n"
    target = pending / f"{version}-{correction_id}.json"
    target.write_text(payload, encoding="utf-8")
    with (root / "audit.jsonl").open("a", encoding="utf-8") as audit:
        audit.write(json.dumps(asdict(correction), ensure_ascii=False) + "\n")
    return correction


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--message-id", required=True)
    parser.add_argument("--corrected-reply-file", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--trainer", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    corrected_reply = Path(args.corrected_reply_file).read_text(encoding="utf-8")
    repo = SheetsRepository(FAST_INDEX_ID)
    row = find_message(repo.read_queue(), args.message_id)
    correction = record_correction(
        row=row,
        corrected_reply=corrected_reply,
        reason=args.reason,
        trainer=args.trainer,
    )
    print(
        "PASS training correction recorded "
        f"id={correction.correction_id} version={correction.version} status={correction.status}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
