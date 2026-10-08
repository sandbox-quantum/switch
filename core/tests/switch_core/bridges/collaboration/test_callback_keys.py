"""Buttons already posted to Mattermost across key changes.

A button carries a signature made with its bridge's callback key when it was
posted, and can be pressed long after. It keeps working after a rotation while
the old key is kept, and a button posted before `SECRET_KEYS` keeps working
while `JWT_SECRET_KEY` is set.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any

from switch_core.bridges.collaboration.ingress import CallbackIngress
from switch_core.bridges.collaboration.mattermost.callback import (
    Press,
    action_context,
    read_press,
)
from switch_core.keys import Keyring

_OLD = "o" * 40
_NEW = "n" * 40
_LEGACY = "legacy-jwt-secret"


def _endpoint(
    value: str, legacy: str | None = None, bridge_id: str = "bridge-1"
) -> Any:
    ingress = CallbackIngress(
        host="127.0.0.1",
        port=0,
        keyring=Keyring.parse(value, legacy_secret=legacy),
    )
    return ingress.endpoint_for("mattermost", bridge_id)


def _press(signing_key: str) -> dict[str, Any]:
    return {
        "user_id": "user-1",
        "post_id": "post-1",
        "channel_id": "channel-1",
        "context": action_context(signing_key, "card-1", 1),
    }


def test_a_button_verifies_with_the_key_it_was_signed_with() -> None:
    endpoint = _endpoint(f"k1:{_OLD}")
    assert isinstance(
        read_press(endpoint.verification_keys, _press(endpoint.key)), Press
    )


def test_a_button_posted_before_a_rotation_still_works() -> None:
    posted_with = _endpoint(f"old:{_OLD}").key
    after = _endpoint(f"new:{_NEW},old:{_OLD}")
    assert after.key != posted_with
    assert isinstance(read_press(after.verification_keys, _press(posted_with)), Press)


def test_and_stops_when_its_key_is_removed() -> None:
    posted_with = _endpoint(f"old:{_OLD}").key
    after = _endpoint(f"new:{_NEW}")
    assert read_press(after.verification_keys, _press(posted_with)) is None


def test_another_bridges_key_does_not_verify() -> None:
    other = _endpoint(f"k1:{_OLD}", bridge_id="bridge-2").key
    assert read_press(_endpoint(f"k1:{_OLD}").verification_keys, _press(other)) is None


def _legacy_bridge_key() -> str:
    """A bridge's callback key as derived from `JWT_SECRET_KEY` before `SECRET_KEYS`."""
    return hmac.new(
        _LEGACY.encode(), b"collaboration-callback:mattermost:bridge-1", hashlib.sha256
    ).hexdigest()


def test_a_button_from_before_secret_keys_works_while_the_legacy_secret_is_set() -> (
    None
):
    endpoint = _endpoint(f"k1:{_NEW}", legacy=_LEGACY)
    assert isinstance(
        read_press(endpoint.verification_keys, _press(_legacy_bridge_key())), Press
    )


def test_and_stops_once_it_is_removed() -> None:
    endpoint = _endpoint(f"k1:{_NEW}")
    assert read_press(endpoint.verification_keys, _press(_legacy_bridge_key())) is None
