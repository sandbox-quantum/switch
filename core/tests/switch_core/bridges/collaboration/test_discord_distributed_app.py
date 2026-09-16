"""The registration walkthrough and the code have to agree, so this compares them.

`docs/old/bridges/DISCORD_DISTRIBUTED_APP.md` carries a pinned contract block:
the OAuth scopes the *Add to Server* URL asks for, the least-privilege
permission integer it requests, and the redirect it registers. Each is a
promise the running system keeps — Discord refuses a redirect that does not
match, and a permission the code needs but the URL never requested surfaces as a
customer's bot silently unable to do its job, with nothing in our logs.

The contract is parsed out of the markdown rather than kept in a fixture,
because a fixture would be a third copy of a value that already lives in the
code and the doc.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from switch_core.bridges.collaboration.discord.install import PERMISSIONS, SCOPES
from switch_core.bridges.collaboration.install import (
    oauth_callback_path,
    public_url,
)

_DOC = (
    Path(__file__).resolve().parents[5]
    / "docs"
    / "old"
    / "bridges"
    / "DISCORD_DISTRIBUTED_APP.md"
)

_HOST = "HOST"


def _contract() -> dict:
    text = _DOC.read_text()
    blocks = re.findall(r"```json\n(.*?)\n```", text, re.DOTALL)
    assert len(blocks) == 1, (
        f"expected exactly one json block in {_DOC.name}, found {len(blocks)}"
    )
    return json.loads(blocks[0])


def test_the_doc_requests_the_scopes_the_code_asks_for() -> None:
    """Same scopes, same order — the order the authorize URL builds them in."""
    assert tuple(_contract()["scopes"]) == SCOPES


def test_the_doc_pins_the_permission_integer_the_code_pins() -> None:
    """A decimal bitfield, exact. A drift here is a permission granted-and-unused
    or needed-and-missing, and only the second is visible, late."""
    assert int(_contract()["permissions"]) == PERMISSIONS


def test_the_doc_registers_the_redirect_the_callback_is_served_at() -> None:
    """The one mismatch Discord refuses outright, byte for byte."""
    expected = public_url(f"https://{_HOST}", oauth_callback_path("discord"))
    assert _contract()["redirect_uri"] == expected
