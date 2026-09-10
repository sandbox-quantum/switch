import hashlib
import re
import unicodedata
import uuid

from switch_core.db.models import MediaBlob
from switch_core.sessions.contract import Attachment

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
MAX_ATTACHMENTS = 8
MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/octet-stream",
}


def attachment_uri(session_id: str, attachment_id: str) -> str:
    uuid.UUID(attachment_id)
    return (
        "sdk-attachment:"
        + hashlib.sha256(f"{session_id}:{attachment_id}".encode()).hexdigest()
    )


def validate_attachment(name: str, mime_type: str, data: bytes) -> None:
    if (
        not name
        or len(name.encode()) > 180
        or name in (".", "..")
        or "/" in name
        or "\\" in name
        or name.endswith((" ", "."))
        or any(unicodedata.category(c).startswith("C") for c in name)
        or re.match(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", name, re.I)
    ):
        raise ValueError(
            "Use a filename without path separators or control characters."
        )
    if not 0 < len(data) <= MAX_ATTACHMENT_BYTES:
        raise ValueError("Attachments must contain 1 byte to 10 MiB.")
    if mime_type not in MIME_TYPES:
        raise ValueError("Unsupported attachment MIME type.")
    signatures = {
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
        "application/pdf": data.startswith(b"%PDF-"),
    }
    if mime_type in signatures and not signatures[mime_type]:
        raise ValueError("The file contents do not match its MIME type.")
    if mime_type.startswith("text/") or mime_type == "application/json":
        data.decode("utf-8")


def attachment_metadata(attachment_id: str, blob: MediaBlob) -> Attachment:
    return Attachment(
        attachment_id=attachment_id,
        name=blob.filename or "attachment",
        mime_type=blob.content_type or "application/octet-stream",
        bytes=blob.size,
    )
