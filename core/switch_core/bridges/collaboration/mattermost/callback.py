from __future__ import annotations

import hashlib
import hmac
import logging
from dataclasses import dataclass
from typing import Any

from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_LABEL,
    Control,
)

logger = logging.getLogger(__name__)

# Where a press carries what it is answering. Nested under one key because
# Mattermost merges nothing of its own into the context, but a flat name is a
# collision waiting for the first card here to want a second kind of button.
CONTEXT_KEY = "switch"

# What each signature is computed over, so a context minted for one purpose can
# never be posted back as another. The kinds of button here are told apart by
# the shape of what they carry — the key sets are disjoint — and the purpose is
# what stops a signature from surviving being relabelled.
_ANSWER_PURPOSE = "answer"
_ACTIVITY_PURPOSE = "activity"
_INTERRUPT_PURPOSE = "interrupt"

# The button that opens a turn's activity, and what it says. One per status
# post, and the same on every status post in a channel: which turn is being
# asked about is the post the press arrives on, which the Mattermost server
# fills in and a client cannot write.
ACTIVITY_ACTION_ID = "switchactivity"
ACTIVITY_LABEL = "Show activity"

# The button that stops what the agent is working on. Letters and digits only,
# which is what Mattermost documents an action id may contain — so the shared
# id the rest of Switch routes a stop press on cannot be written here, and is
# put back on the press once its signed context has been read.
INTERRUPT_ACTION_ID = "switchinterrupt"

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


@dataclass(frozen=True)
class ActivityPress:
    """A press asking to be shown the tool calls behind a turn's status post.

    Carries no subject of its own, unlike `Press`. Which turn is being asked
    about is the post the button sits on, and Mattermost names that post
    itself — the button could not, because a post's id does not exist until
    the post carrying the button has been made.
    """

    user_id: str
    post_id: str
    channel_id: str


@dataclass(frozen=True)
class InterruptPress:
    """A press asking the agent to stop what it is working on.

    Carries its subject, unlike `ActivityPress`, and for the opposite reason:
    the turn to stop is the one the message named when it was drawn, not
    whatever is running when the press lands. A reader who has been looking at
    a status post for a minute presses a control over the work they can see.
    """

    user_id: str
    post_id: str
    channel_id: str
    turn_id: str


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
            "signature": _sign(secret, _ANSWER_PURPOSE, f"{token}:{position}"),
        }
    }


def activity_action(secret: str, url: str, channel_id: str) -> dict[str, Any]:
    """The button that opens a turn's tool calls for whoever presses it.

    Signed over the channel rather than over the post, for a plain reason: at
    the moment this is built the post does not exist, so it has no id to sign.
    The channel is what the context is bound to, and a press is refused unless
    the channel Mattermost says it came from is that one — so a context that
    leaks is worth one conversation's logs rather than the server's.

    Nothing about who may read them is in here. That is asked of Mattermost
    when the press arrives, against the presser the server names.
    """
    return {
        "id": ACTIVITY_ACTION_ID,
        "name": ACTIVITY_LABEL,
        "integration": {
            "url": url,
            "context": {
                CONTEXT_KEY: {
                    "channel": channel_id,
                    "signature": _sign(secret, _ACTIVITY_PURPOSE, channel_id),
                }
            },
        },
    }


def interrupt_action(
    secret: str, url: str, channel_id: str, turn_id: str
) -> dict[str, Any]:
    """The button that asks the agent to stop the turn this post was drawn for.

    The turn is signed alongside the channel rather than trusted from the
    context as written, because this is the one button here whose subject the
    press supplies: a context that could be edited would be a way to name any
    turn on the server and have Switch stop it. The channel is in the signature
    for the same reason it is on the activity button — a context that leaks is
    worth one conversation rather than the key to every one.

    Nothing about who may press it is in here. That is settled against the room
    the post belongs to, after the press arrives, by the same check a typed
    `!interrupt` goes through.
    """
    return {
        "id": INTERRUPT_ACTION_ID,
        "name": INTERRUPT_LABEL,
        "style": "danger",
        "integration": {
            "url": url,
            "context": {
                CONTEXT_KEY: {
                    "channel": channel_id,
                    "turn": turn_id,
                    "signature": _sign(
                        secret, _INTERRUPT_PURPOSE, f"{channel_id}:{turn_id}"
                    ),
                }
            },
        },
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


def read_press(
    secret: str, body: dict[str, Any]
) -> Press | ActivityPress | InterruptPress | None:
    """What a callback is asking for, or None if it is not ours to act on.

    Read as strictly as it is written, and in two stages. A body that does not
    carry a Switch context at all is somebody else's integration posting to a
    shared route, and is passed over quietly. A body that carries one whose
    signature does not verify is a forgery attempt, or a credential that has
    been rotated out from under posts already on the channel, and says so in
    the log — those are worth telling apart, and neither is worth acting on.

    Which kind of button this is comes from the shape of what it carries. The
    key sets are disjoint and each is matched exactly, so the discriminator is
    not a field a forger gets to choose between: a context that is not
    precisely one of the shapes is not read as any of them.

    Only the shape is established here. That the post is the one the card was
    published to, that the turn is one this bridge published, and that this
    person may act on it at all, are decided against the record further in.
    """
    carried = body.get("context")
    if not isinstance(carried, dict):
        return None
    switch = carried.get(CONTEXT_KEY)
    if not isinstance(switch, dict):
        return None
    if set(switch) == {"channel", "signature"}:
        return _activity_press(secret, switch, body)
    if set(switch) == {"channel", "turn", "signature"}:
        return _interrupt_press(secret, switch, body)
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
    if not hmac.compare_digest(
        signature, _sign(secret, _ANSWER_PURPOSE, f"{token}:{position}")
    ):
        logger.warning(
            "Rejected a Mattermost action callback for request %s: the context "
            "signature does not verify. Either it was not signed with this "
            "bridge's credential, or the credential has been rotated since the "
            "card was posted.",
            token,
        )
        return None

    who = _presser(body)
    if who is None:
        return None
    user_id, post_id, channel_id = who
    return Press(
        user_id=user_id,
        post_id=post_id,
        channel_id=channel_id,
        token=token,
        position=position,
    )


def _activity_press(
    secret: str, switch: dict[str, Any], body: dict[str, Any]
) -> ActivityPress | None:
    """A press on the button that opens a turn's tool calls, or None.

    Carries no subject beyond the channel it was signed for. Which turn is
    being asked about is the post the press arrived on, which the Mattermost
    server names and the button could not.
    """
    channel = switch.get("channel")
    signature = switch.get("signature")
    if not isinstance(channel, str) or not channel:
        return None
    if not isinstance(signature, str) or not signature:
        return None
    if not hmac.compare_digest(signature, _sign(secret, _ACTIVITY_PURPOSE, channel)):
        logger.warning(
            "Rejected a Mattermost activity callback for channel %s: the "
            "context signature does not verify. Either it was not signed with "
            "this bridge's credential, or the credential has been rotated "
            "since the post was made.",
            channel,
        )
        return None
    who = _presser_in(body, channel, "activity")
    if who is None:
        return None
    user_id, post_id, channel_id = who
    return ActivityPress(user_id=user_id, post_id=post_id, channel_id=channel_id)


def _interrupt_press(
    secret: str, switch: dict[str, Any], body: dict[str, Any]
) -> InterruptPress | None:
    """A press on the button that stops the agent's current work, or None.

    The turn is carried rather than looked up, and so has to be covered by the
    signature: it is the only subject here a press supplies, and an unsigned
    one would let whoever can reach the route name any turn on the server.
    Whether this bridge ever showed that turn on that post is asked further in,
    against the record; this establishes only that Switch wrote the context.
    """
    channel = switch.get("channel")
    turn = switch.get("turn")
    signature = switch.get("signature")
    if not isinstance(channel, str) or not channel:
        return None
    if not isinstance(turn, str) or not turn:
        return None
    if not isinstance(signature, str) or not signature:
        return None
    if not hmac.compare_digest(
        signature, _sign(secret, _INTERRUPT_PURPOSE, f"{channel}:{turn}")
    ):
        logger.warning(
            "Rejected a Mattermost stop callback for turn %s in channel %s: "
            "the context signature does not verify. Either it was not signed "
            "with this bridge's credential, or the credential has been rotated "
            "since the post was made.",
            turn,
            channel,
        )
        return None
    who = _presser_in(body, channel, "stop")
    if who is None:
        return None
    user_id, post_id, channel_id = who
    return InterruptPress(
        user_id=user_id, post_id=post_id, channel_id=channel_id, turn_id=turn
    )


def _presser_in(
    body: dict[str, Any], channel: str, kind: str
) -> tuple[str, str, str] | None:
    """Who pressed, where the server says they did, and only if that is `channel`.

    The signed channel binds the context to a conversation rather than naming
    one: what anything is decided against is the server's word, and a context
    lifted onto a post somewhere else is refused here rather than resolved
    against either channel.
    """
    who = _presser(body)
    if who is None:
        return None
    channel_id = who[2]
    if channel_id != channel:
        logger.warning(
            "Rejected a Mattermost %s callback: the button was signed for "
            "channel %s and the press arrived from channel %s.",
            kind,
            channel,
            channel_id,
        )
        return None
    return who


def _presser(body: dict[str, Any]) -> tuple[str, str, str] | None:
    """Who pressed, on what, and where — the three fields the server fills in.

    None if any is missing or empty. A press this bridge cannot place is not
    one it can check anything about, and every decision downstream is made
    against one of the three.
    """
    user_id = body.get("user_id")
    post_id = body.get("post_id")
    channel_id = body.get("channel_id")
    if not isinstance(user_id, str) or not user_id:
        return None
    if not isinstance(post_id, str) or not post_id:
        return None
    if not isinstance(channel_id, str) or not channel_id:
        return None
    return user_id, post_id, channel_id


def _sign(secret: str, purpose: str, subject: str) -> str:
    message = f"{purpose}:{subject}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
