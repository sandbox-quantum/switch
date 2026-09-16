from __future__ import annotations

import hashlib
import hmac
import logging
from dataclasses import dataclass
from typing import Any

from switch_core.bridges.collaboration.session.renderers import Control

logger = logging.getLogger(__name__)

# Where a press carries what it is answering. Nested under one key because
# Mattermost merges nothing of its own into the context, but a flat name is a
# collision waiting for the first card here to want a second kind of button.
CONTEXT_KEY = "switch"

# What the signature is computed over, so a value minted for one purpose can
# never be replayed as another if a second kind of button is ever added.
_PURPOSE = "answer"

# How much of an option a button shows. Not a server limit — Mattermost
# documents none — but a width past which a control stops reading as a control
# and starts reading as a paragraph with a border. The body keeps the line of
# any option too long to survive it, so nothing is lost by cutting here.
MAX_BUTTON_LABEL = 76


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


def answer_actions(
    secret: str, url: str, token: str, controls: list[Control]
) -> list[dict[str, Any]]:
    """The buttons a card offers, in the shape a Mattermost post carries them.

    One action per control, each addressed to this bridge's own callback URL
    and carrying its own signed context — the option is in the credential, so
    a press cannot be retargeted at another option by editing anything a
    client can see.

    The id is written rather than left to the server, which mints one per
    action that arrives without it. A card is redrawn many times over its
    life, and an id regenerated on every redraw is a control the client
    remounts underneath a reader who may be mid-press. Letters and digits
    only: that is what Mattermost documents an action id may contain.
    """
    return [
        {
            "id": f"switch{control.position}",
            "name": _button_name(control),
            "integration": {
                "url": url,
                "context": action_context(secret, token, control.position),
            },
        }
        for control in controls
    ]


def _button_name(control: Control) -> str:
    """What the button says: the option's number, then the option.

    Numbered because the number is what a typed answer names, and the card
    still invites one: where the buttons carry the options the body stops
    listing them, so the controls become the only place the reader can see
    which number means what.

    The number is therefore the part that must survive, and the label is cut to
    fit around it. An option too long for `MAX_BUTTON_LABEL` keeps its line in
    the body, where the whole of it is still readable.
    """
    label = control.label.strip() or f"Option {control.position}"
    if len(label) > MAX_BUTTON_LABEL:
        label = label[: MAX_BUTTON_LABEL - 1].rstrip() + "…"
    return f"{control.position}. {label}"


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
