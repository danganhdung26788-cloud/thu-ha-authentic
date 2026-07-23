from __future__ import annotations

import unittest
from datetime import date

from integrations.hermes import telegram_fanpage_review as review


def turn(
    row: int,
    text: str,
    reply: str,
    created: str,
    *,
    customer_id: str = "3396160567101654",
    customer_name: str = "",
    status: str = "SENT",
) -> review.QueueTurn:
    return review.QueueTurn(
        row_number=row,
        message_id=f"m{row}",
        customer_id=customer_id,
        customer_name=customer_name,
        message_text=text,
        draft_reply=reply,
        status=status,
        created_at=created,
        replied_at=created,
        intent="NATURAL_CONVERSATION",
        product_key="",
    )


class TelegramFanpageReviewTests(unittest.TestCase):
    def test_latest_conversation_is_selected_for_today(self) -> None:
        items = [
            turn(2, "cũ", "cũ", "2026-07-22T10:00:00+00:00", customer_id="old"),
            turn(3, "chào em", "dạ em chào chị", "2026-07-23T06:55:53+00:00"),
            turn(4, "số nhà 197 e nhé", "đã ghi nhận", "2026-07-23T07:04:35+00:00"),
        ]
        selected = review.select_conversation(items, target_date=date(2026, 7, 23))
        self.assertEqual([3, 4], [item.row_number for item in selected])

    def test_selector_matches_name_inside_message_without_accents(self) -> None:
        items = [
            turn(
                4,
                "0886299955 - Đặng Anh Dũng, tổ 12 phường Hợp Giang",
                "Dạ em đã ghi nhận",
                "2026-07-23T07:03:36+00:00",
            ),
            turn(5, "số nhà 197 e nhé", "đã ghi nhận", "2026-07-23T07:04:35+00:00"),
        ]
        selected = review.select_conversation(
            items,
            target_date=date(2026, 7, 23),
            selector="dang dung",
        )
        self.assertEqual([4, 5], [item.row_number for item in selected])

    def test_transcript_contains_customer_and_hermes_turns(self) -> None:
        text = review.render_transcript(
            [turn(3, "Chào em", "Dạ em chào chị ạ", "2026-07-23T06:55:53+00:00")]
        )
        self.assertIn("Khách: Chào em", text)
        self.assertIn("Hermes: Dạ em chào chị ạ", text)
        self.assertIn("CUSTOMER_ID=3396160567101654", text)

    def test_repository_uses_readonly_scope_and_module_has_no_write_api(self) -> None:
        with open(review.__file__, encoding="utf-8") as handle:
            source = handle.read()
        self.assertIn("spreadsheets.readonly", source)
        self.assertNotIn("batchUpdate(", source)
        self.assertNotIn("MetaClient", source)
        self.assertNotIn("send_text(", source)


if __name__ == "__main__":
    unittest.main()
