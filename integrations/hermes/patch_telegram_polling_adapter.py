"""Idempotently patch the installed Hermes getUpdates adapter for Issue #39."""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

CALLBACK_BEGIN = "        # ISSUE39_TASK_CALLBACK_BEGIN"
CALLBACK_END = "        # ISSUE39_TASK_CALLBACK_END"
TEXT_BEGIN = "        # ISSUE39_TASK_TEXT_BEGIN"
TEXT_END = "        # ISSUE39_TASK_TEXT_END"
CALLBACK_ANCHOR = "        # --- Model picker callbacks ---"
TEXT_ANCHOR = "        if not self._should_process_message(msg):"

CALLBACK_BLOCK = f"""{CALLBACK_BEGIN}
        if data.startswith((\"ht:\", \"htp:\", \"htt:\", \"htc:\")):
            import sys
            task_integration_root = \"/opt/data/tha-integrations\"
            if task_integration_root not in sys.path:
                sys.path.insert(0, task_integration_root)
            from integrations.hermes.task_checklist_polling import handle_callback_query
            await handle_callback_query(query, context)
            return
{CALLBACK_END}
"""

TEXT_BLOCK = f"""{TEXT_BEGIN}
        import sys
        task_integration_root = \"/opt/data/tha-integrations\"
        if task_integration_root not in sys.path:
            sys.path.insert(0, task_integration_root)
        from integrations.hermes.task_checklist_polling import maybe_handle_text_message
        if await maybe_handle_text_message(update, context):
            return
{TEXT_END}
"""


def patch_adapter(path: Path) -> bool:
    source = path.read_text(encoding="utf-8")
    if CALLBACK_BEGIN in source and TEXT_BEGIN in source:
        return False
    if CALLBACK_BEGIN in source or TEXT_BEGIN in source:
        raise RuntimeError("Partial Issue #39 patch detected; refusing to continue")
    text_handler = source.find("    async def _handle_text_message(")
    if source.count(CALLBACK_ANCHOR) != 1 or text_handler < 0:
        raise RuntimeError("Hermes adapter anchors changed; patch aborted")
    text_anchor = source.find(TEXT_ANCHOR, text_handler)
    next_handler = source.find("\n    async def ", text_handler + 1)
    if text_anchor < 0 or (next_handler >= 0 and text_anchor >= next_handler):
        raise RuntimeError("Hermes text handler anchor changed; patch aborted")
    backup = path.with_suffix(path.suffix + ".issue39.bak")
    if not backup.exists():
        shutil.copyfile(path, backup)
    source = source.replace(CALLBACK_ANCHOR, CALLBACK_BLOCK + CALLBACK_ANCHOR)
    text_handler = source.find("    async def _handle_text_message(")
    text_anchor = source.find(TEXT_ANCHOR, text_handler)
    source = source[:text_anchor] + TEXT_BLOCK + source[text_anchor:]
    path.write_text(source, encoding="utf-8")
    return True


def rollback_adapter(path: Path) -> None:
    backup = path.with_suffix(path.suffix + ".issue39.bak")
    if not backup.exists():
        raise RuntimeError(f"Backup does not exist: {backup}")
    shutil.copyfile(backup, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--adapter",
        default="/opt/hermes/plugins/platforms/telegram/adapter.py",
    )
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    path = Path(args.adapter)
    if args.rollback:
        rollback_adapter(path)
        print("ROLLED_BACK")
    else:
        print("PATCHED" if patch_adapter(path) else "ALREADY_PATCHED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
