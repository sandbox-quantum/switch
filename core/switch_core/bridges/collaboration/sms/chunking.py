"""Encoding-aware, bounded SMS splitting."""

from __future__ import annotations

GSM_BASIC = frozenset(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
GSM_EXTENSION = frozenset("^{}\\[~]|€")
TRUNCATION = "... [truncated; see Switch]"


def _gsm_units(text: str) -> int | None:
    units = 0
    for character in text:
        if character in GSM_BASIC:
            units += 1
        elif character in GSM_EXTENSION:
            units += 2
        else:
            return None
    return units


def _units(text: str, *, gsm: bool) -> int:
    if gsm:
        value = _gsm_units(text)
        assert value is not None
        return value
    return len(text.encode("utf-16-be")) // 2


def _take(text: str, *, limit: int, gsm: bool) -> tuple[str, str]:
    used = 0
    end = 0
    for index, character in enumerate(text):
        cost = _units(character, gsm=gsm)
        if used + cost > limit:
            break
        used += cost
        end = index + 1
    if end == len(text):
        return text, ""
    candidate = text[:end]
    boundary = max(candidate.rfind("\n"), candidate.rfind(" "))
    if boundary > limit // 3:
        end = boundary
    return text[:end].rstrip(), text[end:].lstrip()


def chunk_sms(text: str, *, max_segments: int) -> tuple[list[str], bool]:
    """Return at most ``max_segments`` independently billable SMS bodies."""
    gsm = _gsm_units(text) is not None
    limit = 160 if gsm else 70
    remaining = text.strip()
    chunks: list[str] = []
    while remaining and len(chunks) < max_segments:
        chunk, remaining = _take(remaining, limit=limit, gsm=gsm)
        chunks.append(chunk)
    if not remaining:
        return chunks or [""], False

    marker_cost = _units(TRUNCATION, gsm=gsm)
    keep_limit = max(1, limit - marker_cost - 1)
    kept, _ = _take(chunks[-1], limit=keep_limit, gsm=gsm)
    chunks[-1] = f"{kept.rstrip()} {TRUNCATION}".strip()
    return chunks, True
