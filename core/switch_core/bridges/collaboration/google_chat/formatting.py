from __future__ import annotations

import re
from typing import Any

# Google Chat text limit is 32,000 bytes. We use 30,000 to leave headroom for formatting/overhead.
MAX_CHAT_MESSAGE_BYTES = 30000

# Pattern for fenced code blocks: ```lang ... ``` or ``` ... ```
_CODE_BLOCK_PATTERN = re.compile(r"(```[\s\S]*?```)", re.DOTALL)
# Pattern for inline code spans: `code`
_INLINE_CODE_PATTERN = re.compile(r"(`[^`\n]+`)")
# Pattern for Markdown links: [text](url)
_LINK_PATTERN = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
# Pattern for bold: **text** or __text__
_BOLD_PATTERN = re.compile(r"(?<!\*)\*\*([^*\n]+?)\*\*(?!\*)|(?<!_)__([^_\n]+?)__(?!_)")
# Pattern for strikethrough: ~~text~~
_STRIKE_PATTERN = re.compile(r"~~([^~\n]+?)~~")
# Pattern for italic: *text* (when not bold) or _text_
_ITALIC_PATTERN = re.compile(r"(?<!\*)\*([^*\n]+?)\*(?!\*)|(?<!_)_([^_\n]+?)_(?!_)")


def markdown_to_google_chat(text: str) -> str:
    """Convert standard Markdown to Google Chat supported formatting.

    Google Chat formatting rules:
    - Bold: *bold*
    - Italic: _italic_
    - Strikethrough: ~strikethrough~
    - Monospace: `code` or ```code block```
    - Links: <url|text>
    """
    if not text:
        return ""

    # Split text into protected code tokens (blocks and inline) and normal prose
    # so we don't mess up asterisks/underscores inside code!
    parts: list[str] = []
    last_idx = 0

    # Match both code blocks and inline code
    code_pattern = re.compile(r"(```[\s\S]*?```|`[^`\n]+`)")
    for match in code_pattern.finditer(text):
        start, end = match.span()
        if start > last_idx:
            parts.append(_convert_prose(text[last_idx:start]))
        parts.append(match.group(0))
        last_idx = end

    if last_idx < len(text):
        parts.append(_convert_prose(text[last_idx:]))

    return "".join(parts)


def _convert_prose(prose: str) -> str:
    """Convert Markdown formatting in non-code text segments."""

    # Convert links: [text](url) -> <url|text>
    def link_repl(match: re.Match[str]) -> str:
        label = match.group(1)
        url = match.group(2)
        return f"<{url}|{label}>"

    res = _LINK_PATTERN.sub(link_repl, prose)

    # Convert bold: **text** or __text__ -> *text*
    def bold_repl(match: re.Match[str]) -> str:
        content = match.group(1) or match.group(2)
        return f"*{content}*"

    res = _BOLD_PATTERN.sub(bold_repl, res)

    # Convert strikethrough: ~~text~~ -> ~text~
    res = _STRIKE_PATTERN.sub(r"~\1~", res)

    # Convert italic: single *text* or _text_ -> _text_
    # Note: asterisks that were **bold** have already been converted to *content*
    # So we don't convert single asterisks into _ unless they were explicitly single * in markdown
    # But in Google Chat, *bold* is bold, so any *text* will render bold!
    return res


def split_message_chunks(
    text: str, max_bytes: int = MAX_CHAT_MESSAGE_BYTES
) -> list[str]:
    """Split a long text message into chunks below `max_bytes` without breaking code fences."""
    if not text:
        return [""]

    raw_bytes = text.encode("utf-8")
    if len(raw_bytes) <= max_bytes:
        return [text]

    chunks: list[str] = []
    remaining = text
    in_code_block = False
    code_block_lang = ""

    while remaining:
        prefix = ""
        if in_code_block:
            prefix = f"```{code_block_lang}\n" if code_block_lang else "```\n"

        # If remaining fits in one chunk taking prefix into account
        if len((prefix + remaining).encode("utf-8")) <= max_bytes:
            chunks.append(prefix + remaining)
            break

        # Available space for candidate: max_bytes - len(prefix) - 10 (for trailing \n```)
        budget = max_bytes - len(prefix.encode("utf-8")) - 10
        candidate_len = min(len(remaining), budget)
        while len(remaining[:candidate_len].encode("utf-8")) > budget:
            candidate_len -= 50

        segment = remaining[:candidate_len]

        # Look for natural split boundaries: \n\n, then \n, then space
        split_pos = -1
        p_idx = segment.rfind("\n\n")
        if p_idx > candidate_len // 2:
            split_pos = p_idx + 2
        else:
            n_idx = segment.rfind("\n")
            if n_idx > candidate_len // 2:
                split_pos = n_idx + 1
            else:
                s_idx = segment.rfind(" ")
                if s_idx > candidate_len // 2:
                    split_pos = s_idx + 1
                else:
                    split_pos = candidate_len

        chunk_text = remaining[:split_pos]
        remaining = remaining[split_pos:].lstrip("\r\n")

        # Check code fence balance in chunk_text
        fence_matches = list(re.finditer(r"```([a-zA-Z0-9_-]*)", chunk_text))
        for fm in fence_matches:
            if not in_code_block:
                in_code_block = True
                code_block_lang = fm.group(1).strip()
            else:
                in_code_block = False
                code_block_lang = ""

        out_chunk = prefix + chunk_text
        if in_code_block:
            # Need to close open fence for this chunk
            out_chunk = out_chunk + "\n```"

        chunks.append(out_chunk)

    return chunks


def is_app_user(user: dict[str, Any]) -> bool:
    """Whether a Chat API user is an app rather than a person."""
    return user.get("type") == "BOT" or user.get("name") == "users/app"


def bot_mention_annotations(
    annotations: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """The USER_MENTION annotations that point at an app."""
    return [
        ann
        for ann in annotations or []
        if ann.get("type") == "USER_MENTION"
        and is_app_user(ann.get("userMention", {}).get("user", {}))
    ]


def strip_bot_mention(
    text: str,
    argument_text: str | None,
    annotations: list[dict[str, Any]] | None,
) -> str:
    """The message body without the app's own @mention.

    Google computes `argumentText` for messages addressed to the app, so it is
    used when present. Otherwise only the spans the annotations identify as an
    app mention are cut; any other `@name` in the text is left for routing.
    """
    if argument_text is not None and argument_text.strip():
        return argument_text.strip()
    if not text:
        return ""

    spans: list[tuple[int, int]] = []
    for ann in bot_mention_annotations(annotations):
        start = ann.get("startIndex")
        length = ann.get("length")
        if isinstance(start, int) and isinstance(length, int):
            spans.append((start, start + length))
            continue
        name = ann.get("userMention", {}).get("user", {}).get("displayName")
        if name:
            found = re.search(rf"@{re.escape(name)}(?![\w-])", text)
            if found:
                spans.append(found.span())

    result = text
    for start, end in sorted(set(spans), reverse=True):
        head, tail = result[:start], result[end:]
        if head.endswith(" ") and tail.startswith(" "):
            tail = tail[1:]
        result = head + tail
    return result.strip()
