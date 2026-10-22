"""Switch Trust for files: what an attached file is checked as.

Switch Trust only reads text, so a file is checked through the text it
carries (`switch_core.file_text`): a text-like file as its decoded text, a
Word document as the text of its body, headers, footers, notes and comments,
and a PDF as the text of its pages, each up to `TRUST_FILE_TEXT_LIMIT`
characters. Everything else (images, audio, video, archives, other office
formats, binaries, scanned PDFs with no text layer, files that cannot be
parsed within Switch's limits) cannot be read here, and
`RELAY_UNCHECKED_FILES` decides what happens to it.

A file cannot be redacted the way a message can, so a REDACTED verdict on a
file's text blocks the message it came with, the same as BLOCKED.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass

from switch_core.file_text import (
    TRUST_FILE_TEXT_LIMIT,
    FileText,
    extract_file_text,
    read_file_text,
)
from switch_core.trust.client import (
    Role,
    TrustCheckResult,
    TrustClient,
    TrustFinding,
    check_message,
)

__all__ = [
    "RELAY_UNCHECKED_FILES",
    "TRUST_FILE_TEXT_LIMIT",
    "AttachmentsVerdict",
    "FileText",
    "check_attachments",
    "extract_file_text",
]

logger = logging.getLogger(__name__)

# What Switch does with a file Switch Trust cannot read (an image, a scanned
# PDF, an archive), or with the part of one it cannot. True relays it with a
# visible "not checked" note on the message and a WARNING in the log; False
# blocks the whole message instead. This is the one place that choice is
# made, for people and agents alike.
RELAY_UNCHECKED_FILES = True


@dataclass(frozen=True)
class AttachmentsVerdict:
    """What Switch Trust made of a message's files, taken together.

    `blocked` means nothing from the message may be relayed; `block_reasons`
    says why, one plain phrase per file, for the notice, and `block` is the
    verdict to report it under. Otherwise `notes`
    are the visible annotations the message must carry (a file not checked,
    checked only in part, flagged, or not checked because Switch Trust
    failed), and `flagged` is True when one of them is an ALERTED verdict."""

    block: TrustCheckResult | None = None
    block_reasons: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()
    flagged: bool = False

    @property
    def blocked(self) -> bool:
        return self.block is not None


def _categories(result: TrustCheckResult, fallback: str) -> str:
    return ", ".join(sorted({f.category for f in result.findings})) or fallback


async def check_attachments(
    client: TrustClient,
    *,
    role: Role,
    files: Sequence[tuple[bytes, str, str]],
    room_id: str,
) -> AttachmentsVerdict:
    """Check every file in `files` ((data, filename, mimetype) each) against
    Switch Trust, concurrently. Only call this when Switch Trust is on
    (`trust_is_active`): when it is off, no file is read at all."""
    texts = await asyncio.gather(
        *(
            read_file_text(data, mimetype, filename)
            for data, filename, mimetype in files
        )
    )
    extracted = [
        (filename, file_text)
        for (_data, filename, _mimetype), file_text in zip(files, texts)
    ]
    # Indexed by position, not filename: two files in one post can share a name.
    to_check = [
        (index, file_text.text)
        for index, (_filename, file_text) in enumerate(extracted)
        if file_text.text is not None and file_text.text.strip()
    ]
    results = await asyncio.gather(
        *(
            check_message(client, role=role, content=text, room_id=room_id)
            for _index, text in to_check
        )
    )
    checked = {index: result for (index, _), result in zip(to_check, results)}

    block_reasons: list[str] = []
    block_result: TrustCheckResult | None = None
    notes: list[str] = []
    flagged = False
    for index, (filename, file_text) in enumerate(extracted):
        unchecked = (
            [file_text.unreadable_reason]
            if file_text.unreadable_reason is not None
            else list(file_text.skipped)
        )
        result = checked.get(index)
        if result is not None and result.outcome == "blocked":
            block_reasons.append(
                f"{filename} was blocked ({_categories(result, 'policy violation')})"
            )
            block_result = block_result or result
            continue
        if result is not None and result.outcome == "redacted":
            block_reasons.append(
                f"{filename} holds content Switch Trust would redact "
                f"({_categories(result, 'policy violation')}), and a file "
                "cannot be redacted safely"
            )
            block_result = block_result or TrustCheckResult(
                outcome="blocked",
                policy_id=result.policy_id,
                policy_name=result.policy_name,
                findings=result.findings,
            )
            continue
        if unchecked and not RELAY_UNCHECKED_FILES:
            what = (
                "could not be checked"
                if file_text.text is None
                else "could not all be checked"
            )
            block_reasons.append(f"{filename} {what} ({'; '.join(unchecked)})")
            block_result = block_result or TrustCheckResult(
                outcome="blocked",
                policy_id=None,
                policy_name=None,
                findings=(
                    TrustFinding(
                        category="unchecked file",
                        detector_name="switch",
                        severity=None,
                    ),
                ),
            )
            continue
        if result is not None and result.outcome == "alerted":
            flagged = True
            notes.append(
                f"⚠️ _Switch Trust flagged {filename} (not blocked - "
                f"{_categories(result, 'policy alert')})._"
            )
        elif result is not None and result.outcome == "errored":
            notes.append(f"⚠️ _Switch Trust could not check {filename}._")
        if unchecked:
            what = "" if file_text.text is None else "part of "
            logger.warning(
                "Switch Trust did not check %s attachment %s (%s); relaying it "
                "with a note in room %s",
                what or "the",
                filename,
                "; ".join(unchecked),
                room_id,
            )
            notes.append(
                f"⚠️ _Switch Trust did not check {what}{filename} "
                f"({'; '.join(unchecked)})._"
            )
        # Noted whether or not the checked part held anything: a file padded
        # with blank space up to the cap is still unchecked past it.
        if file_text.checked_part is not None:
            logger.warning(
                "Switch Trust checked only %s (%d characters) of attachment %s "
                "(%d bytes) in room %s; the rest reaches the room unchecked",
                file_text.checked_part,
                len(file_text.text or ""),
                filename,
                len(files[index][0]),
                room_id,
            )
            notes.append(
                f"⚠️ _Switch Trust checked only {file_text.checked_part} of "
                f"{filename}; the rest was not checked._"
            )

    if block_result is not None:
        return AttachmentsVerdict(
            block=block_result, block_reasons=tuple(block_reasons)
        )
    return AttachmentsVerdict(notes=tuple(notes), flagged=flagged)
