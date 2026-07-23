"""Pause-aware wrapper around the production Meta Messenger bridge."""
from __future__ import annotations

import logging

from integrations.hermes import meta_messenger_bridge as bridge
from integrations.hermes.telegram_fanpage_ops import OpsStore

LOGGER = logging.getLogger("tha_meta_messenger_bridge_ops")


def ingest_message(message_id: str, sender_id: str, message_text: str) -> None:
    if bridge.DEDUPE.seen(message_id):
        return
    bridge.QueueWriter(bridge.FAST_INDEX_ID).append_fanpage_message(
        message_id=message_id,
        sender_id=sender_id,
        message_text=message_text,
    )
    bridge.DEDUPE.mark(message_id)
    if OpsStore().is_paused(sender_id):
        LOGGER.info("Customer paused; message ingested without auto reply customer_id=%s", sender_id)
        return
    try:
        bridge.run_realtime_pipeline()
    except Exception:
        LOGGER.exception("Realtime pipeline failed; Scheduled Task will retry queued messages")


bridge.ingest_message = ingest_message
app = bridge.app
