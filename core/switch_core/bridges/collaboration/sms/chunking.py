r"""SMS text formatting and segment-aware budgeting.

SMS messaging is billed by carriers per segment:
- GSM-7 encoding: 160 characters for a single segment; 153 characters per segment
  when concatenated. Certain extended characters (^, {, }, \, [, ~, ], |, €)
  cost 2 characters each.
- UCS-2 encoding (triggered by emoji, smart quotes, or non-GSM-7 characters):
  70 characters for a single segment; 67 characters per segment when concatenated.

Rather than splitting a message into multiple API calls (which each restart at
single-segment pricing), Switch renders the bounded body into a single message
capped at the operator's segment budget and submits it to Twilio in one API call.
"""

from __future__ import annotations

import re

# GSM 03.38 7-bit basic character set
_GSM7_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)

# GSM 03.38 7-bit extension characters (escaped with 0x1b, costing 2 septets)
_GSM7_EXTENDED = set("\f^{}\\[~]|€")


def is_gsm7(text: str) -> bool:
    """Return True if every character in ``text`` belongs to GSM-7 (basic or extended)."""
    return all(c in _GSM7_BASIC or c in _GSM7_EXTENDED for c in text)


def gsm7_encoded_length(text: str) -> int:
    """Calculate effective septet length in GSM-7, counting extended chars as 2."""
    length = 0
    for c in text:
        if c in _GSM7_EXTENDED:
            length += 2
        elif c in _GSM7_BASIC:
            length += 1
        else:
            # Fallback if called with non-GSM char
            length += 1
    return length


def ucs2_encoded_length(text: str) -> int:
    """Calculate UCS-2 code unit length, correctly counting surrogate pairs as 2."""
    return len(text.encode("utf-16-be")) // 2


def calculate_segments(text: str) -> tuple[int, str]:
    """Calculate segment count and encoding ('gsm7' or 'ucs2') for ``text``."""
    if not text:
        return 0, "gsm7"

    if is_gsm7(text):
        length = gsm7_encoded_length(text)
        if length <= 160:
            return 1, "gsm7"
        segments = (length + 152) // 153
        return segments, "gsm7"
    else:
        length = ucs2_encoded_length(text)
        if length <= 70:
            return 1, "ucs2"
        segments = (length + 66) // 67
        return segments, "ucs2"


def max_capacity_for_segments(max_segments: int, encoding: str) -> int:
    """Return maximum character capacity for ``max_segments`` under ``encoding``."""
    if max_segments <= 0:
        return 0
    if encoding == "gsm7":
        if max_segments == 1:
            return 160
        return max_segments * 153
    else:
        if max_segments == 1:
            return 70
        return max_segments * 67


def strip_markdown(text: str) -> str:
    """Flatten common markdown structures into readable plain text for SMS."""
    # Convert markdown links: [label](url) -> label (url) or just url if label same
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text)
    # Remove bold, italics, strikethrough (*, **, _, __, ~~)
    text = re.sub(r"(\*\*|__)(.*?)\1", r"\2", text)
    text = re.sub(r"(\*|_)(.*?)\1", r"\2", text)
    text = re.sub(r"~~(.*?)~~", r"\1", text)
    # Remove code blocks: ```lang ... ``` -> ...
    text = re.sub(r"```[a-zA-Z0-9_-]*\n?(.*?)```", r"\1", text, flags=re.DOTALL)
    # Remove inline code backticks: `code` -> code
    text = re.sub(r"`([^`]+)`", r"\1", text)
    # Convert markdown headers: # Header -> Header
    text = re.sub(r"^#{1,6}\s+(.+)$", r"\1", text, flags=re.MULTILINE)
    # Standardize list bullets
    text = re.sub(r"^\s*[*+]\s+", "- ", text, flags=re.MULTILINE)
    # Collapse multiple consecutive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def render_bounded_sms(
    sender_name: str,
    content: str,
    max_segments: int = 3,
) -> str:
    """Render plain text with agent prefix and bound total size to ``max_segments``.

    If content exceeds the segment budget, trims cleanly at word boundaries
    and appends a truncation notice, ensuring the entire final payload
    (prefix + body + notice) fits within the configured segment budget.
    """
    clean_body = strip_markdown(content)
    prefix = f"[{sender_name}] " if sender_name else ""
    full_text = f"{prefix}{clean_body}"

    # Determine encoding for the combined text
    encoding = "gsm7" if is_gsm7(full_text) else "ucs2"
    budget_limit = max_capacity_for_segments(max_segments, encoding)

    def current_length(s: str) -> int:
        return gsm7_encoded_length(s) if encoding == "gsm7" else ucs2_encoded_length(s)

    if current_length(full_text) <= budget_limit:
        return full_text

    # Content exceeds budget: reserve space for truncation notice
    notice = f"\n[...truncated to {max_segments} segments]"
    needed_for_notice = current_length(notice)
    prefix_len = current_length(prefix)
    available_for_body = budget_limit - prefix_len - needed_for_notice

    if available_for_body <= 0:
        return f"{prefix}{clean_body[: max(0, budget_limit - prefix_len)]}"

    # Trim clean_body to available_for_body
    if encoding == "gsm7":
        trimmed = ""
        current = 0
        for char in clean_body:
            cost = 2 if char in _GSM7_EXTENDED else 1
            if current + cost > available_for_body:
                break
            trimmed += char
            current += cost
    else:
        trimmed = clean_body[:available_for_body]

    # Trim back to last whitespace if possible
    last_space = max(trimmed.rfind(" "), trimmed.rfind("\n"))
    if last_space > len(trimmed) // 2:
        trimmed = trimmed[:last_space]

    trimmed = trimmed.rstrip()
    return f"{prefix}{trimmed}{notice}"
