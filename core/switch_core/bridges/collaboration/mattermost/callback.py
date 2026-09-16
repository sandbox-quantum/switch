from __future__ import annotations

import hashlib
import hmac
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# Where a press carries what it is answering. Nested under one key because
# Mattermost merges nothing of its own into the context, but a flat name is a
# collision waiting for the first card here to want a second kind of button.
CONTEXT_KEY = "switch"

# What the signature is computed over, so a value minted for one purpose can
# never be replayed as another if a second kind of button is ever added.
_PURPOSE = "answer"

# What the bridge's own key is derived from, kept apart from anything else the
# server secret is used for.
_KEY_PURPOSE = "mattermost-callback"


def callback_key(server_secret: str, bridge_id: str) -> str:
    """The key this bridge signs its buttons with.

    Derived rather than stored. A secret on the bridge's saved configuration
    would have to be minted when the bridge is registered, which leaves every
    Mattermost bridge registered before this existed unable to carry a button
    until somebody edits its configuration by hand — and adds a second secret
    to keep, back up and rotate. Deriving it costs none of that: the key exists
    the moment the bridge starts, and rotating the server secret rotates it.

    Separated by bridge, so one bridge's signature cannot be presented to
    another, and by purpose, so it is not the same value as anything else
    derived from the same secret. Rotating the server secret invalidates the
    buttons on cards already posted; those cards stay answerable by typing, and
    a press on one is refused in the log by name rather than silently.
    """
    return hmac.new(
        server_secret.encode(),
        f"{_KEY_PURPOSE}:{bridge_id}".encode(),
        hashlib.sha256,
    ).hexdigest()


@dataclass(frozen=True)
class Press:
    """A button press Mattermost vouched for, before Switch has judged it.

    Everything here is asserted by the server rather than by the button: the
    ids come from the request body, which only Mattermost can produce a valid
    signature for. What the button carried is the card and the option, neither
    of which says who may press it.
    """

    user_id: str
    post_id: str
    channel_id: str
    token: str
    position: int


def action_context(secret: str, token: str, position: int) -> dict[str, Any]:
    """The hidden data a button carries, signed so a forgery cannot be built.

    Mattermost keeps an action's context confidential — it is never serialised
    to a client — and documents it as the place to put a value that proves a
    callback came from the server. What goes here is a signature rather than
    the secret itself, so that a context which does leak, through a bug or a
    database dump, hands over one card's button rather than the key to every
    card's.

    The card's token is the subject, not the credential: it says which request
    is being answered and nothing about who may answer it. Authority is decided
    afterwards, against the actor Mattermost names.
    """
    return {
        CONTEXT_KEY: {
            "token": token,
            "position": position,
            "signature": _sign(secret, token, position),
        }
    }


def read_press(secret: str, body: dict[str, Any]) -> Press | None:
    """What a callback is asking for, or None if it is not ours to act on.

    Read as strictly as it is written, and in two stages. A body that does not
    carry a Switch context at all is somebody else's integration posting to a
    shared route, and is passed over quietly. A body that carries one whose
    signature does not verify is a forgery attempt, or a credential that has
    been rotated out from under posts already on the channel, and says so in
    the log — those are worth telling apart, and neither is worth acting on.

    Only the shape is established here. That the post is the one the card was
    published to, and that this person may answer it at all, are decided
    against the record further in.
    """
    carried = body.get("context")
    if not isinstance(carried, dict):
        return None
    switch = carried.get(CONTEXT_KEY)
    if not isinstance(switch, dict):
        return None
    # Nothing but what was signed. The signature covers the card and the
    # option, so a field beside them is one it does not vouch for — and a
    # reader added later would be reading an unsigned value out of a context
    # that looks authentic. Refusing the whole thing keeps the signature's
    # promise the same size as the context.
    if set(switch) != {"token", "position", "signature"}:
        return None

    token = switch.get("token")
    position = switch.get("position")
    signature = switch.get("signature")
    if not isinstance(token, str) or not token:
        return None
    if isinstance(position, bool) or not isinstance(position, int) or position < 1:
        return None
    if not isinstance(signature, str) or not signature:
        return None
    if not hmac.compare_digest(signature, _sign(secret, token, position)):
        logger.warning(
            "Rejected a Mattermost action callback for request %s: the context "
            "signature does not verify. Either it was not signed with this "
            "bridge's credential, or the credential has been rotated since the "
            "card was posted.",
            token,
        )
        return None

    user_id = body.get("user_id")
    post_id = body.get("post_id")
    channel_id = body.get("channel_id")
    if not isinstance(user_id, str) or not user_id:
        return None
    if not isinstance(post_id, str) or not post_id:
        return None
    if not isinstance(channel_id, str) or not channel_id:
        return None
    return Press(
        user_id=user_id,
        post_id=post_id,
        channel_id=channel_id,
        token=token,
        position=position,
    )


def _sign(secret: str, token: str, position: int) -> str:
    message = f"{_PURPOSE}:{token}:{position}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
