"""The operator page and the code have to agree, so this compares them.

`docs/old/bridges/TELEGRAM_DISTRIBUTED_APP.md` shows the webhook Switch sets at
boot — the URL Telegram posts to and the updates it is asked for — so an
operator can check their ingress and read what the bot hears. Nothing at
runtime compares the page with what `setWebhook` is actually sent, and a page
that drifted would send someone routing the wrong path.

Parsed out of the markdown rather than kept in a fixture, because a fixture
would be a third copy.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from switch_core.bridges.collaboration.install import events_path, public_url
from switch_core.bridges.collaboration.telegram.app_client import ALLOWED_UPDATES

_DOC = (
    Path(__file__).resolve().parents[5]
    / "docs"
    / "old"
    / "bridges"
    / "TELEGRAM_DISTRIBUTED_APP.md"
)


def _webhook() -> dict:
    blocks = re.findall(r"```json\n(.*?)\n```", _DOC.read_text(), re.DOTALL)
    assert len(blocks) == 1, (
        f"expected exactly one json block in {_DOC.name}, found {len(blocks)}"
    )
    return json.loads(blocks[0])


def test_the_page_names_the_url_switch_serves() -> None:
    assert _webhook()["url"] == public_url("https://HOST", events_path("telegram"))


def test_the_page_names_the_updates_switch_asks_for() -> None:
    assert _webhook()["allowed_updates"] == list(ALLOWED_UPDATES)
