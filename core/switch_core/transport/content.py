"""The event bodies Switch sends, assembled once for every transport.

A message's content dict is not Matrix's — it is Switch's own shape, which the
collaboration bridges, the agent read path and the message log all read. Only
the delivery of it is a transport's business. Two transports assembling it
separately would drift, and the drift would show up as a bridge that renders a
caption on one deployment and a filename on another.

The shapes keep their `m.`-prefixed keys. They are what is in every row already
written and what three shipped connectors read; renaming them is a protocol
change, and it is not this module's to make.
"""

from __future__ import annotations

import markdown

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.transport.types import MessageFormat


def thread_relation(thread_root_id: str) -> dict[str, object]:
    """A pure `m.thread` relation, with no `m.in_reply_to` fallback.

    The root id must already be an actual thread root; mid-thread ids are
    normalised upstream.
    """
    return {"rel_type": "m.thread", "event_id": thread_root_id}


def message_content(
    body: str,
    *,
    sender_name: str,
    format: MessageFormat = "text",
    mentions: list[str] | None = None,
    thread_root_id: str | None = None,
    extra_content: dict[str, object] | None = None,
) -> dict[str, object]:
    content: dict[str, object] = {
        "msgtype": "m.text",
        "body": body,
        "sender_name": sender_name,
    }
    # Caller-supplied content fields (e.g. a `com.switch.*` marker) are merged
    # in. They ride on the plain message — the body still renders normally; the
    # extra keys are metadata other clients can read.
    if extra_content:
        content.update(extra_content)

    if format == "markdown":
        content["format"] = "org.matrix.custom.html"
        content["formatted_body"] = _rendered(body, mentions)

    if thread_root_id is not None:
        content["m.relates_to"] = thread_relation(thread_root_id)

    return content


def media_content(
    uri: str,
    filename: str,
    mimetype: str,
    size: int,
    *,
    sender_name: str,
    msgtype: str,
    caption: str | None = None,
    thread_root_id: str | None = None,
    group: dict[str, object] | None = None,
) -> dict[str, object]:
    # When a caption is given it becomes the event body, with the real filename
    # carried separately per the rich-media-caption convention.
    content: dict[str, object] = {
        "msgtype": msgtype,
        "body": caption if caption else filename,
        "url": uri,
        "info": {"mimetype": mimetype, "size": size},
        "sender_name": sender_name,
    }
    if caption:
        content["filename"] = filename
    if group is not None:
        content[ATTACHMENT_GROUP_KEY] = group
    if thread_root_id is not None:
        content["m.relates_to"] = thread_relation(thread_root_id)
    return content


def _rendered(body: str, mentions: list[str] | None) -> str:
    """Markdown as HTML, with each mentioned id turned into a link.

    The link target is a matrix.to URL because that is what a Matrix client
    renders as a mention pill, and it is the one addressing signal with no
    plain-text equivalent — `AddressingResolver.mentions_name` looks for the
    id inside the rendered body. A transport with no pill convention of its own
    still wants the id there for exactly that reason, so the form is shared
    rather than being made Matrix-only.
    """
    html = markdown.markdown(body)
    for user_id in mentions or ():
        local = user_id.split(":")[0].lstrip("@")
        html = html.replace(
            f"@{local}", f'<a href="https://matrix.to/#/{user_id}">{local}</a>'
        )
    return html
