"""The text inside an attached file, read so Switch Trust can check it.

A text-like file (text/*, JSON, YAML, CSV, Markdown, source code, or anything
else that decodes cleanly as UTF-8) is its decoded text, a Word document
(.docx) is the text of its body and of the headers, footers, notes and
comments the body links to, and a PDF is the text of its pages, each up to
`TRUST_FILE_TEXT_LIMIT` characters. Everything else (images, audio, video,
archives, other office formats, binaries, scanned PDFs with no text layer,
files that cannot be parsed) has no text that can be read here. The type and
extension a file arrives with are the sender's to choose, so a file labelled
as one of those, or named .docx or .pdf but not one, is still read as text
when its bytes are text.

Word documents and PDFs are parsed in a separate, short-lived process
(`read_file_text`), killed if it takes longer than
`_WORKER_TIMEOUT_SECONDS` and, on Linux, held to `_WORKER_MEMORY_BYTES` of
address space. A small upload can describe an enormous amount of work (a
compressed XML part, a page with half a million drawing operations), and no
limit applied inside one parser call bounds that; a process can be killed.
This module is also that process's entry point (`python -m
switch_core.file_text`), so it imports nothing from the server.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import posixpath
import resource
import sys
import weakref
import zipfile
import zlib
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from typing import IO, Literal
from urllib.parse import unquote
from xml.parsers import expat

from pypdf import PageObject, PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, NameObject

from switch_core.sessions.attachments import normalise_mime_type

logger = logging.getLogger(__name__)

# The most text taken from one file for a check. Anything in a file past this
# point reaches agents WITHOUT being checked by Switch Trust. The cap exists
# because a check has to answer inside `switch_trust_timeout_seconds` (2s by
# default) and Switch Trust is built for a message's worth of text, not a
# whole log or book; a slower check would fail open as "could not check"
# anyway. Every file cut here carries a visible note on the message saying so,
# and a WARNING is logged, so the gap is never silent.
TRUST_FILE_TEXT_LIMIT = 20_000

# Bounds on reading documents, so a small upload cannot cost unbounded work.
# A .docx is a zip: only members stored or deflated are opened (Python's
# LZMA and bzip2 readers can inflate far past what was asked of them in a
# single read), and only while their declared size fits what is left of this
# budget, which zipfile then holds them to. A PDF is read page by page, up to
# this many pages, through a page tree of at most this many nodes.
_DOCX_XML_BYTE_BUDGET = 8 * 1024 * 1024
_DOCX_RELS_BYTE_LIMIT = 1024 * 1024
_PDF_PAGE_LIMIT = 200
_PDF_TREE_NODE_LIMIT = 10_000

# The worker process that parses a document. Ten seconds is far more than a
# real document needs to give up its first 20,000 characters, and short
# enough that a hostile one cannot hold a message for long. 512 MiB of address
# space leaves room for the interpreter, pypdf and the largest upload Switch
# accepts. Two at once keeps a burst of documents from taking every core.
_WORKER_TIMEOUT_SECONDS = 10.0
_WORKER_MEMORY_BYTES = 512 * 1024 * 1024
_WORKER_SLOTS = 2

_DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_PDF_TYPE = "application/pdf"
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# Relationship types (the last segment of a relationship's Type) of the
# parts a reader of a Word document sees text from, besides the body.
_DOCX_TEXT_PARTS = frozenset({"header", "footer", "footnotes", "endnotes", "comments"})
# Relationship types whose content Word shows as part of the document but
# which are not WordprocessingML this module can read.
_DOCX_OPAQUE_PARTS = {
    "aFChunk": "an embedded document",
    "subDocument": "a subdocument",
}
_ZIP_READABLE = frozenset({zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED})

# Types Switch has no way to read the text of. The type is only what the
# sender declared, so a file of one of these is still read as text when its
# bytes decode cleanly: real images and archives almost never do, and
# checking a few that happen to costs far less than relaying unchecked text.
_TEXTLESS_KINDS: tuple[tuple[str, str], ...] = (
    ("image/", "images cannot be checked"),
    ("audio/", "audio cannot be checked"),
    ("video/", "video cannot be checked"),
    ("font/", "fonts cannot be checked"),
    ("application/msword", "older Word documents (.doc) cannot be checked"),
    (
        "application/vnd.openxmlformats-officedocument.",
        "Office documents other than Word cannot be checked",
    ),
    ("application/vnd.ms-", "Office documents other than Word cannot be checked"),
    ("application/vnd.oasis.opendocument.", "OpenDocument files cannot be checked"),
    ("application/zip", "archives cannot be checked"),
    ("application/gzip", "archives cannot be checked"),
    ("application/x-tar", "archives cannot be checked"),
    ("application/x-7z-compressed", "archives cannot be checked"),
    ("application/x-rar-compressed", "archives cannot be checked"),
    ("application/vnd.rar", "archives cannot be checked"),
    ("application/x-bzip2", "archives cannot be checked"),
    ("application/x-xz", "archives cannot be checked"),
)

DocumentKind = Literal["docx", "pdf"]


@dataclass(frozen=True)
class FileText:
    """The text a file is checked as, or why it has none.

    Exactly one of `text` and `unreadable_reason` is set. `checked_part` is
    set when only the start of the file was read ("the first 20,000
    characters"), and `skipped` names the parts of it that could not be read
    at all (a Word document's embedded document), each for the note that
    says so. `textless` is set when the file is of a kind Switch never reads
    text from (an image, an archive, a binary), as opposed to one it tried
    and failed to read."""

    text: str | None
    checked_part: str | None = None
    unreadable_reason: str | None = None
    skipped: tuple[str, ...] = field(default=())
    textless: bool = False


def _unreadable(reason: str) -> FileText:
    return FileText(text=None, unreadable_reason=reason)


def _capped(
    text: str, checked_part: str | None = None, skipped: tuple[str, ...] = ()
) -> FileText:
    if len(text) > TRUST_FILE_TEXT_LIMIT:
        return FileText(
            text=text[:TRUST_FILE_TEXT_LIMIT],
            checked_part=f"the first {TRUST_FILE_TEXT_LIMIT:,} characters",
            skipped=skipped,
        )
    return FileText(text=text, checked_part=checked_part, skipped=skipped)


def _as_text(data: bytes) -> FileText | None:
    """`data` as text, or None when it is not cleanly text."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    if "\x00" in text:
        # Valid UTF-8 can still be binary: NUL never appears in real text.
        return None
    return _capped(text)


def _unparsed(data: bytes, reason: str) -> FileText:
    """A file sent to a document parser that could not parse it. It went
    there by its declared type or extension, which the sender chooses, so
    one whose bytes are text is checked as text instead."""
    return _as_text(data) or _unreadable(reason)


def _refuse_dtd(*_args: object) -> None:
    # Word never writes a DTD; one here is a crafted file (entity expansion),
    # not a document. Expat reports the declaration itself, so it is caught
    # whatever the encoding or chunk boundaries.
    raise ValueError("document declares a DTD")


def _docx_part_text(stream: IO[bytes], budget: int) -> tuple[str, int, bool]:
    """The visible text of one WordprocessingML part, read through
    `stream` (a decompressing zip member) a chunk at a time. Returns the
    text, the bytes read, and whether it stopped before the end of the part
    (byte budget or text cap reached)."""
    parser = expat.ParserCreate(namespace_separator="}")
    pieces: list[str] = []
    in_text = False
    length = 0

    def start(tag: str, _attrs: object) -> None:
        nonlocal in_text
        name = "{" + tag
        if name == f"{_W}t":
            in_text = True
        elif name == f"{_W}tab":
            pieces.append("\t")
        elif name == f"{_W}br":
            pieces.append("\n")

    def end(tag: str) -> None:
        nonlocal in_text
        name = "{" + tag
        if name == f"{_W}t":
            in_text = False
        elif name == f"{_W}p":
            pieces.append("\n")

    def text(data: str) -> None:
        nonlocal length
        if in_text:
            pieces.append(data)
            length += len(data)

    parser.StartDoctypeDeclHandler = _refuse_dtd
    parser.EntityDeclHandler = _refuse_dtd
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    read = 0
    while True:
        chunk = stream.read(min(64 * 1024, budget - read))
        if not chunk:
            stopped_early = bool(stream.read(1))
            if not stopped_early:
                parser.Parse(b"", True)
            return "".join(pieces), read, stopped_early
        read += len(chunk)
        parser.Parse(chunk, False)
        if length > TRUST_FILE_TEXT_LIMIT:
            return "".join(pieces), read, True


_UNREADABLE_COMPRESSION = "uses a compression Switch Trust does not read"


def _member_problem(info: zipfile.ZipInfo, budget: int) -> str | None:
    """Why a zip member is not opened, checked from its header alone."""
    if info.compress_type not in _ZIP_READABLE:
        return _UNREADABLE_COMPRESSION
    if info.file_size > budget:
        return "is larger than Switch Trust reads"
    return None


@dataclass(frozen=True)
class _Relationship:
    kind: str
    target: str | None
    """The part's name in the zip, or None for a link outside the file."""


def _relationships(
    archive: zipfile.ZipFile, members: dict[str, zipfile.ZipInfo], source: str
) -> list[_Relationship] | None:
    """The relationships of `source` ("" for the package itself), from its
    .rels part; None when it has none. Raises ValueError when the .rels part
    cannot be read safely."""
    directory, name = posixpath.split(source)
    info = members.get(posixpath.join(directory, "_rels", f"{name}.rels").lower())
    if info is None:
        return None
    problem = _member_problem(info, _DOCX_RELS_BYTE_LIMIT)
    if problem is not None:
        raise ValueError(f"{info.filename} {problem}")
    found: list[_Relationship] = []

    def start(tag: str, attrs: dict[str, str]) -> None:
        if not tag.endswith("}Relationship") or "Target" not in attrs:
            return
        kind = attrs.get("Type", "").rpartition("/")[2]
        if attrs.get("TargetMode") == "External":
            found.append(_Relationship(kind, None))
            return
        target = unquote(attrs["Target"])
        path = (
            target[1:] if target.startswith("/") else posixpath.join(directory, target)
        )
        path = posixpath.normpath(path)
        found.append(_Relationship(kind, None if path.startswith("..") else path))

    parser = expat.ParserCreate(namespace_separator="}")
    parser.StartDoctypeDeclHandler = _refuse_dtd
    parser.EntityDeclHandler = _refuse_dtd
    parser.StartElementHandler = start
    with archive.open(info) as stream:
        parser.Parse(stream.read(_DOCX_RELS_BYTE_LIMIT), True)
    return found


def _docx_text(data: bytes) -> FileText:
    skipped: list[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = {info.filename.lower(): info for info in archive.infolist()}
            # The body is the part the package names as its main document; a
            # zip without the package's own list is read as Word lays it out.
            package = _relationships(archive, members, "")
            if package is None:
                main: str | None = "word/document.xml"
            else:
                main = next(
                    (r.target for r in package if r.kind == "officeDocument"), None
                )
            if main is None or main.lower() not in members:
                return _unparsed(data, "this Word document could not be read")
            parts = [members[main.lower()]]
            try:
                links = _relationships(archive, members, members[main.lower()].filename)
            except ValueError as error:
                skipped.append(f"its headers, footers, notes and comments ({error})")
                links = []
            for link in links or []:
                if link.kind in _DOCX_OPAQUE_PARTS:
                    skipped.append(_DOCX_OPAQUE_PARTS[link.kind])
                elif link.kind not in _DOCX_TEXT_PARTS:
                    continue
                elif link.target is None or link.target.lower() not in members:
                    skipped.append(
                        f"a {link.kind} part it links to but does not contain"
                    )
                elif members[link.target.lower()] not in parts:
                    parts.append(members[link.target.lower()])

            pieces: list[str] = []
            budget = _DOCX_XML_BYTE_BUDGET
            stopped_early = False
            for index, info in enumerate(parts):
                problem = _member_problem(info, budget)
                # A body larger than the budget is read up to it rather than
                # not at all: the reader stops there, so the size its header
                # declares costs nothing, and its start is still checked.
                if problem is not None and (
                    index > 0 or problem == _UNREADABLE_COMPRESSION
                ):
                    if index == 0:
                        return _unreadable(f"this Word document {problem}")
                    skipped.append(f"{info.filename}, which {problem}")
                    continue
                with archive.open(info) as stream:
                    text, read, stopped_early = _docx_part_text(stream, budget)
                pieces.append(text)
                budget -= read
                if stopped_early:
                    break
    except (
        zipfile.BadZipFile,
        expat.ExpatError,
        ValueError,
        OSError,
        EOFError,
        zlib.error,
        # What zipfile raises for an encrypted member.
        RuntimeError,
    ):
        logger.warning("Could not read text from a Word document", exc_info=True)
        return _unparsed(data, "this Word document could not be read")
    text = "\n".join(p for p in pieces if p)
    if not text.strip():
        if skipped:
            return _unreadable(
                f"no text found in this Word document, and {'; '.join(skipped)} "
                "could not be read"
            )
        return _unreadable("no text found in this Word document")
    # Reading stops early at the text cap, which `_capped` reports, or at the
    # byte budget, with less text than the cap.
    checked_part = (
        "the first part"
        if stopped_early and len(text) <= TRUST_FILE_TEXT_LIMIT
        else None
    )
    return _capped(text, checked_part, skipped=tuple(skipped))


def _pdf_pages(reader: PdfReader) -> Iterator[PageObject]:
    """The document's pages in order, found one at a time. `reader.pages`
    walks the whole page tree before giving the first page, which a crafted
    tree makes as costly as its author likes."""
    pending: list[tuple[object, dict[str, object]]] = [
        (reader.root_object.get("/Pages"), {})
    ]
    seen: set[tuple[int, int]] = set()
    visited = 0
    while pending:
        visited += 1
        if visited > _PDF_TREE_NODE_LIMIT:
            raise ValueError("the page tree is larger than Switch Trust reads")
        entry, inherited = pending.pop()
        reference = entry if isinstance(entry, IndirectObject) else None
        if reference is not None:
            key = (reference.idnum, reference.generation)
            if key in seen:
                continue
            seen.add(key)
            entry = reference.get_object()
        if not isinstance(entry, DictionaryObject):
            continue
        kids = entry.get("/Kids")
        if entry.get("/Type") == "/Pages" or (
            kids is not None and entry.get("/Type") != "/Page"
        ):
            passed_down = dict(inherited)
            for name in ("/Resources", "/MediaBox", "/CropBox", "/Rotate"):
                if name in entry:
                    passed_down[name] = entry[name]
            kids = kids.get_object() if kids is not None else None
            if isinstance(kids, ArrayObject):
                pending.extend((kid, passed_down) for kid in reversed(kids))
            continue
        page = PageObject(reader, reference)
        if reference is None:
            page.update(entry)
        for name, value in inherited.items():
            if name not in page:
                page[NameObject(name)] = value  # type: ignore[assignment]
        yield page


def _pdf_text(data: bytes) -> FileText:
    pieces: list[str] = []
    length = 0
    checked_part: str | None = None
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            return _unreadable("encrypted PDFs cannot be checked")
        for number, page in enumerate(_pdf_pages(reader)):
            if number >= _PDF_PAGE_LIMIT:
                checked_part = f"the first {_PDF_PAGE_LIMIT} pages"
                break
            page_text = page.extract_text() or ""
            pieces.append(page_text)
            length += len(page_text)
            if length > TRUST_FILE_TEXT_LIMIT:
                break
    except MemoryError:
        raise
    except Exception:
        # pypdf raises a wide and unstable set of errors on malformed input
        # (its own, but also ValueError, KeyError, struct errors); any of
        # them means the same here: this PDF could not be read.
        logger.warning("Could not read text from a PDF", exc_info=True)
        return _unparsed(data, "this PDF could not be read")
    text = "\n".join(pieces)
    if not text.strip():
        # A scanned PDF is pictures of text: nothing to check is not clean.
        return _unreadable("no text found in this PDF, it may be scanned")
    return _capped(text, checked_part)


def _document_kind(data: bytes, mimetype: str, filename: str) -> DocumentKind | None:
    """Documents are recognised by type or file extension, since platforms
    often label them application/octet-stream."""
    kind = normalise_mime_type(mimetype)
    extension = filename.lower().rpartition(".")[2] if "." in filename else ""
    if kind == _DOCX_TYPE or extension == "docx":
        return "docx"
    if kind == _PDF_TYPE or extension == "pdf" or data.startswith(b"%PDF-"):
        return "pdf"
    return None


def _document_text(kind: DocumentKind, data: bytes) -> FileText:
    return _docx_text(data) if kind == "docx" else _pdf_text(data)


def extract_file_text(data: bytes, mimetype: str, filename: str) -> FileText:
    """The text Switch Trust should check for one file, read in this
    process. Never raw binary: anything that is not cleanly text comes back
    unreadable, with a reason a person can read. Use `read_file_text` for a
    file from outside; this parses documents with no bound on time or
    memory."""
    document = _document_kind(data, mimetype, filename)
    if document is not None:
        return _document_text(document, data)
    as_text = _as_text(data)
    if as_text is not None:
        return as_text
    kind = normalise_mime_type(mimetype)
    reason = next(
        (reason for prefix, reason in _TEXTLESS_KINDS if kind.startswith(prefix)),
        "binary files cannot be checked",
    )
    return FileText(text=None, unreadable_reason=reason, textless=True)


_worker_slots: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, asyncio.Semaphore
] = weakref.WeakKeyDictionary()


def _slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    slots = _worker_slots.get(loop)
    if slots is None:
        slots = _worker_slots[loop] = asyncio.Semaphore(_WORKER_SLOTS)
    return slots


async def read_file_text(data: bytes, mimetype: str, filename: str) -> FileText:
    """`extract_file_text` for a file from outside: a Word document or a PDF
    is parsed in a worker process held to a time limit and, on Linux, a
    memory limit, and one that exceeds either comes back unreadable, with a
    WARNING logged."""
    document = _document_kind(data, mimetype, filename)
    if document is None:
        return await asyncio.to_thread(extract_file_text, data, mimetype, filename)
    async with _slots():
        return await _read_in_worker(document, data, filename)


async def _read_in_worker(kind: DocumentKind, data: bytes, filename: str) -> FileText:
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "switch_core.file_text",
        kind,
        str(_WORKER_MEMORY_BYTES),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(data), _WORKER_TIMEOUT_SECONDS
        )
    except TimeoutError:
        logger.warning(
            "Reading the text of %s took longer than %.0fs; stopped it, and the "
            "file is not checked by Switch Trust",
            filename,
            _WORKER_TIMEOUT_SECONDS,
        )
        return _unreadable("it took too long to read")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    errors = stderr.decode(errors="replace").strip()[-4000:]
    try:
        if process.returncode != 0:
            raise ValueError(f"exit status {process.returncode}")
        fields = json.loads(stdout)
        result = FileText(
            text=fields["text"],
            checked_part=fields["checked_part"],
            unreadable_reason=fields["unreadable_reason"],
            skipped=tuple(fields["skipped"]),
            textless=fields["textless"],
        )
    except (ValueError, KeyError, TypeError) as error:
        logger.warning(
            "Could not read the text of %s within Switch Trust's limits (%s); "
            "the file is not checked. Reader output: %s",
            filename,
            error,
            errors or "(none)",
        )
        return _unreadable("it could not be read within Switch's limits")
    if result.unreadable_reason is not None and errors:
        logger.warning("Reading the text of %s: %s", filename, errors)
    return result


def _limit_memory(limit: int) -> None:
    # Only Linux enforces an address-space limit; elsewhere the time limit
    # is the only bound.
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def _worker_main(kind: str, memory_limit: int) -> None:
    _limit_memory(memory_limit)
    if kind not in ("docx", "pdf"):
        raise SystemExit(f"unknown document kind {kind!r}")
    result = _document_text(kind, sys.stdin.buffer.read())  # type: ignore[arg-type]
    json.dump(asdict(result), sys.stdout)


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    _worker_main(sys.argv[1], int(sys.argv[2]))
