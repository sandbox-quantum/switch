"""What an attached file is checked as, and how a message's files are judged
together. The two call sites (inbound bridge, agent send_media) are tested
separately; this covers the decisions they share."""

import io
import logging
import sys
import zipfile

import pytest
from pypdf import PdfReader, PdfWriter

from switch_core import file_text as file_text_module
from switch_core.file_text import read_file_text
from switch_core.trust import attachments
from switch_core.trust.attachments import (
    TRUST_FILE_TEXT_LIMIT,
    AttachmentsVerdict,
    check_attachments,
    extract_file_text,
)
from switch_core.trust.client import TrustCheckResult, TrustFinding


class _ContentTrustClient:
    """Blocks text containing FORBIDDEN, redacts text containing SECRET,
    flags text containing FLAG, and allows the rest. Records what it saw."""

    def __init__(self) -> None:
        self.checked: list[tuple[str, str]] = []

    async def is_active(self) -> bool:
        return True

    async def check(self, *, role: str, content: str, room_id: str) -> TrustCheckResult:
        self.checked.append((role, content))
        finding = (TrustFinding(category="test", detector_name="t", severity="high"),)
        if "FORBIDDEN" in content:
            return TrustCheckResult("blocked", "p", "policy", finding)
        if "SECRET" in content:
            return TrustCheckResult(
                "redacted", "p", "policy", finding, content.replace("SECRET", "x")
            )
        if "FLAG" in content:
            return TrustCheckResult("alerted", "p", "policy", finding)
        return TrustCheckResult("ok", "p", "policy")


@pytest.mark.parametrize(
    ("mimetype", "data"),
    [
        ("text/plain", b"hello"),
        ("application/json", b'{"a": 1}'),
        ("application/x-yaml", b"a: 1"),
        ("text/csv; charset=utf-8", b"a,b\n1,2"),
        ("application/octet-stream", b"print('hi')"),
        ("image/svg+xml", b"<svg></svg>"),
    ],
)
def test_text_like_files_are_read_as_text(mimetype: str, data: bytes) -> None:
    file_text = extract_file_text(data, mimetype, "file")
    assert file_text.text == data.decode()
    assert file_text.unreadable_reason is None


@pytest.mark.parametrize(
    ("mimetype", "data"),
    [
        ("image/png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"),
        ("application/pdf", b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n\x00"),
        (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            b"PK\x03\x04\x14\x00\x00\x00",
        ),
        ("application/zip", b"PK\x03\x04\x14\x00\x00\x00"),
        ("application/octet-stream", b"\xff\xfe\x00\x01"),
        ("text/plain", b"nul\x00inside"),
    ],
)
def test_files_without_readable_text_are_never_sent_as_text(
    mimetype: str, data: bytes
) -> None:
    file_text = extract_file_text(data, mimetype, "file")
    assert file_text.text is None
    assert file_text.unreadable_reason


@pytest.mark.parametrize(
    ("mimetype", "filename"),
    [
        ("image/png", "secrets.txt"),
        ("application/zip", "secrets.zip"),
        ("audio/mpeg", "secrets.mp3"),
        ("application/pdf", "notes.pdf"),
        ("application/octet-stream", "notes.pdf"),
        ("application/octet-stream", "notes.docx"),
        (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "notes.docx",
        ),
    ],
)
def test_text_labelled_or_named_as_something_else_is_still_checked(
    mimetype: str, filename: str
) -> None:
    # The type and the name are the sender's to choose; the bytes decide.
    secret = b"API_KEY=placeholder-credential-value\n"
    file_text = extract_file_text(secret, mimetype, filename)
    assert file_text.text == secret.decode()
    assert file_text.unreadable_reason is None


async def test_text_named_as_a_document_is_checked_through_the_worker() -> None:
    secret = b"API_KEY=placeholder-credential-value\n"
    file_text = await read_file_text(secret, "application/octet-stream", "notes.pdf")
    assert file_text.text == secret.decode()


async def test_an_image_alone_carries_no_note_and_is_not_checked() -> None:
    client = _ContentTrustClient()
    verdict = await check_attachments(
        client,  # type: ignore[arg-type]
        role="user",
        files=[(b"\x89PNG", "cat.png", "image/png")],
        room_id="room-1",
    )
    assert verdict == AttachmentsVerdict()
    assert client.checked == []


async def test_an_image_still_blocks_when_unchecked_files_are_not_relayed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(attachments, "RELAY_UNCHECKED_FILES", False)
    verdict = await check_attachments(
        _ContentTrustClient(),  # type: ignore[arg-type]
        role="user",
        files=[(b"\x89PNG", "cat.png", "image/png")],
        room_id="room-1",
    )
    assert verdict.blocked
    assert "cat.png could not be checked" in verdict.block_reasons[0]


def test_long_text_is_cut_to_the_limit() -> None:
    file_text = extract_file_text(
        b"a" * (TRUST_FILE_TEXT_LIMIT + 5), "text/plain", "big.log"
    )
    assert file_text.text is not None
    assert len(file_text.text) == TRUST_FILE_TEXT_LIMIT
    assert file_text.checked_part == "the first 20,000 characters"


async def test_a_blocked_file_blocks_and_names_the_file() -> None:
    client = _ContentTrustClient()
    verdict = await check_attachments(
        client,  # type: ignore[arg-type]
        role="user",
        files=[(b"fine", "a.txt", "text/plain"), (b"FORBIDDEN", "b.txt", "text/plain")],
        room_id="room-1",
    )
    assert verdict.blocked
    assert any("b.txt" in reason for reason in verdict.block_reasons)
    assert sorted(content for _, content in client.checked) == ["FORBIDDEN", "fine"]


async def test_a_redacted_file_blocks_because_a_file_cannot_be_redacted() -> None:
    verdict = await check_attachments(
        _ContentTrustClient(),  # type: ignore[arg-type]
        role="user",
        files=[(b"my SECRET", "notes.md", "text/markdown")],
        room_id="room-1",
    )
    assert verdict.blocked
    assert verdict.block is not None and verdict.block.outcome == "blocked"
    assert "cannot be redacted" in verdict.block_reasons[0]


async def test_unreadable_flagged_and_long_files_each_carry_a_note() -> None:
    client = _ContentTrustClient()
    verdict = await check_attachments(
        client,  # type: ignore[arg-type]
        role="assistant",
        files=[
            (b"\x89PNG", "cat.png", "image/png"),
            (b"%PDF-1.4\x00garbage", "scan.pdf", "application/pdf"),
            (b"FLAG", "f.txt", "text/plain"),
            (b"b" * (TRUST_FILE_TEXT_LIMIT + 1), "long.log", "text/plain"),
        ],
        room_id="room-1",
    )
    assert not verdict.blocked
    assert verdict.flagged
    notes = "\n".join(verdict.notes)
    assert "did not check scan.pdf (this PDF could not be read)" in notes
    # An image is a kind Switch never reads, so it carries no note.
    assert "cat.png" not in notes
    assert "flagged f.txt" in notes
    assert (
        "checked only the first 20,000 characters of long.log; the rest was not checked"
        in notes
    )
    # The image's bytes were never sent.
    assert all(role == "assistant" for role, _ in client.checked)
    assert len(client.checked) == 2


async def test_a_file_padded_with_blank_space_still_says_the_rest_was_not_checked() -> (
    None
):
    client = _ContentTrustClient()
    verdict = await check_attachments(
        client,  # type: ignore[arg-type]
        role="user",
        files=[(b" " * TRUST_FILE_TEXT_LIMIT + b"FORBIDDEN", "pad.txt", "text/plain")],
        room_id="room-1",
    )
    assert not verdict.blocked
    assert client.checked == []
    assert verdict.notes == (
        "⚠️ _Switch Trust checked only the first 20,000 characters of pad.txt; "
        "the rest was not checked._",
    )


async def test_unchecked_files_block_when_the_policy_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(attachments, "RELAY_UNCHECKED_FILES", False)
    verdict = await check_attachments(
        _ContentTrustClient(),  # type: ignore[arg-type]
        role="user",
        files=[(b"\x89PNG", "cat.png", "image/png")],
        room_id="room-1",
    )
    assert verdict.blocked
    assert "cat.png could not be checked" in verdict.block_reasons[0]


_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _part(text: str, padding: int = 0) -> str:
    return (
        f'<w:document xmlns:w="{_W_NS}"><w:body><w:p><w:r>'
        f"<w:t>{text}</w:t></w:r></w:p>{'<w:p/>' * padding}</w:body></w:document>"
    )


def _rels(*links: tuple[str, str, str]) -> str:
    """A .rels part: (type, target, extra attributes) per relationship."""
    return (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
        'relationships">'
        + "".join(
            f'<Relationship Id="r{i}" Type="{_REL}/{kind}" Target="{target}"{extra}/>'
            for i, (kind, target, extra) in enumerate(links)
        )
        + "</Relationships>"
    )


def _zip(members: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def _docx(
    body: str,
    *,
    header: str | None = None,
    header_name: str = "header1.xml",
    padding: int = 0,
    links: tuple[tuple[str, str, str], ...] = (),
    compression: dict[str, int] | None = None,
) -> bytes:
    """A minimal Word document: the package's and the body's relationships,
    and the parts the reader looks at. `compression` overrides how named
    members are stored."""
    members = {
        "[Content_Types].xml": "<Types/>",
        "_rels/.rels": _rels(("officeDocument", "word/document.xml", "")),
        "word/document.xml": _part(body, padding),
    }
    body_links = list(links)
    if header is not None:
        members[f"word/{header_name}"] = _part(header)
        body_links.append(("header", header_name, ""))
    members["word/_rels/document.xml.rels"] = _rels(*body_links)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(
                name,
                content,
                compress_type=(compression or {}).get(name, zipfile.ZIP_DEFLATED),
            )
    return buffer.getvalue()


def _pdf(*pages: str | None) -> bytes:
    """A minimal PDF, one page per entry: a line of Helvetica text, or a
    page with no text layer at all (None), as a scanned page has."""
    count = len(pages)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(count))
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {count} >>",
    ]
    font = 3 + 2 * count
    for i, text in enumerate(pages):
        content = f"BT /F1 12 Tf 72 712 Td ({text}) Tj ET" if text else ""
        objects.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font} 0 R >> >> /Contents {4 + 2 * i} 0 R >>"
        )
        objects.append(f"<< /Length {len(content)} >>\nstream\n{content}\nendstream")
    objects.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return out


_DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def test_a_word_document_is_read_body_and_header() -> None:
    file_text = extract_file_text(
        _docx("the body", header="the header"), _DOCX_TYPE, "memo.docx"
    )
    assert file_text.text is not None
    assert "the body" in file_text.text
    assert "the header" in file_text.text


def test_a_word_document_is_recognised_by_extension_alone() -> None:
    file_text = extract_file_text(
        _docx("hello"), "application/octet-stream", "memo.docx"
    )
    assert file_text.text is not None and "hello" in file_text.text


@pytest.mark.parametrize(
    "data",
    [
        b"PK\x03\x04\x00 not really a zip",
        # A zip without a document body is not a Word document.
        _docx("x").replace(b"word/document.xml", b"word/documenX.xml"),
        # Nor is one whose package names a body it does not contain.
        _zip(
            {
                "_rels/.rels": _rels(("officeDocument", "word/gone.xml", "")),
                "word/document.xml": _part("x"),
            }
        ),
    ],
)
def test_a_broken_word_document_is_unchecked_not_an_error(data: bytes) -> None:
    file_text = extract_file_text(data, _DOCX_TYPE, "memo.docx")
    assert file_text.text is None
    assert file_text.unreadable_reason == "this Word document could not be read"


def test_a_word_document_declaring_a_dtd_is_refused() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "word/document.xml",
            '<!DOCTYPE x [<!ENTITY a "aaaa">]><w:document xmlns:w="'
            f'{_W_NS}"><w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body>'
            "</w:document>",
        )
    file_text = extract_file_text(buffer.getvalue(), _DOCX_TYPE, "memo.docx")
    assert file_text.text is None


def test_a_word_document_body_larger_than_the_budget_is_checked_up_to_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A highly compressible body (a zip bomb, in the limit) is inflated only
    # up to the budget, whatever size it declares, and that much is checked.
    monkeypatch.setattr(file_text_module, "_DOCX_XML_BYTE_BUDGET", 2_000)
    file_text = extract_file_text(
        _docx("API_KEY=early", padding=100_000), _DOCX_TYPE, "bomb.docx"
    )
    assert file_text.text is not None
    assert "API_KEY=early" in file_text.text
    assert file_text.checked_part == "the first part"


def test_a_header_past_the_budget_is_named_as_not_checked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(file_text_module, "_DOCX_XML_BYTE_BUDGET", 2_000)
    file_text = extract_file_text(
        _docx("the body", header="x" * 5_000), _DOCX_TYPE, "memo.docx"
    )
    assert file_text.text is not None and "the body" in file_text.text
    assert file_text.skipped == (
        "word/header1.xml, which is larger than Switch Trust reads",
    )


@pytest.mark.parametrize("method", [zipfile.ZIP_LZMA, zipfile.ZIP_BZIP2])
def test_a_word_document_body_not_stored_or_deflated_is_never_inflated(
    method: int,
) -> None:
    # Python's LZMA and bzip2 readers inflate past what one read asks for, so
    # a tiny member could cost far more memory than the budget allows.
    data = _docx("the body", compression={"word/document.xml": method})
    file_text = extract_file_text(data, _DOCX_TYPE, "memo.docx")
    assert file_text.text is None
    assert file_text.unreadable_reason == (
        "this Word document uses a compression Switch Trust does not read"
    )


def test_a_header_not_stored_or_deflated_is_named_as_not_checked() -> None:
    data = _docx(
        "the body",
        header="FORBIDDEN",
        compression={"word/header1.xml": zipfile.ZIP_LZMA},
    )
    file_text = extract_file_text(data, _DOCX_TYPE, "memo.docx")
    assert file_text.text is not None and "FORBIDDEN" not in file_text.text
    assert file_text.skipped == (
        "word/header1.xml, which uses a compression Switch Trust does not read",
    )


async def test_a_renamed_header_is_found_through_the_relationships() -> None:
    # Word finds a header by the body's relationships, not by its file name.
    client = _ContentTrustClient()
    verdict = await check_attachments(
        client,  # type: ignore[arg-type]
        role="user",
        files=[
            (
                _docx("the body", header="FORBIDDEN", header_name="custom-header.xml"),
                "memo.docx",
                _DOCX_TYPE,
            )
        ],
        room_id="room-1",
    )
    assert verdict.blocked
    assert "memo.docx was blocked" in verdict.block_reasons[0]


def test_a_body_the_package_names_elsewhere_is_the_one_read() -> None:
    data = _zip(
        {
            "_rels/.rels": _rels(("officeDocument", "/content/main.xml", "")),
            "content/main.xml": _part("the real body"),
            "word/document.xml": _part("a decoy"),
        }
    )
    file_text = extract_file_text(data, _DOCX_TYPE, "memo.docx")
    assert file_text.text is not None
    assert "the real body" in file_text.text
    assert "a decoy" not in file_text.text


async def test_parts_of_a_word_document_that_cannot_be_read_carry_a_note() -> None:
    data = _docx(
        "the body",
        links=(
            ("aFChunk", "afchunk.mht", ""),
            ("footer", "https://example.com/footer.xml", ' TargetMode="External"'),
            ("footnotes", "footnotes.xml", ""),
        ),
    )
    file_text = extract_file_text(data, _DOCX_TYPE, "memo.docx")
    assert file_text.skipped == (
        "an embedded document",
        "a footer part it links to but does not contain",
        "a footnotes part it links to but does not contain",
    )
    verdict = await check_attachments(
        _ContentTrustClient(),  # type: ignore[arg-type]
        role="user",
        files=[(data, "memo.docx", _DOCX_TYPE)],
        room_id="room-1",
    )
    assert not verdict.blocked
    [note] = verdict.notes
    assert "did not check part of memo.docx (an embedded document;" in note


def test_a_word_document_with_no_text_is_unchecked() -> None:
    file_text = extract_file_text(_docx(""), _DOCX_TYPE, "pictures.docx")
    assert file_text.text is None
    assert file_text.unreadable_reason == "no text found in this Word document"


def test_a_pdf_is_read_page_by_page() -> None:
    file_text = extract_file_text(
        _pdf("first page", "second page"), "application/pdf", "doc.pdf"
    )
    assert file_text.text is not None
    assert "first page" in file_text.text
    assert "second page" in file_text.text
    assert file_text.checked_part is None


def test_a_scanned_pdf_with_no_text_is_unchecked_not_clean() -> None:
    file_text = extract_file_text(_pdf(None), "application/pdf", "scan.pdf")
    assert file_text.text is None
    assert "no text found in this PDF" in (file_text.unreadable_reason or "")


def test_a_malformed_pdf_is_unchecked_not_an_error() -> None:
    file_text = extract_file_text(b"%PDF-1.4\x00garbage", "application/pdf", "x.pdf")
    assert file_text.unreadable_reason == "this PDF could not be read"


def test_an_encrypted_pdf_is_unchecked() -> None:
    writer = PdfWriter()
    writer.add_blank_page(100, 100)
    writer.encrypt("secret")
    buffer = io.BytesIO()
    writer.write(buffer)
    file_text = extract_file_text(buffer.getvalue(), "application/pdf", "x.pdf")
    assert file_text.unreadable_reason == "encrypted PDFs cannot be checked"


def test_a_pdf_past_the_page_limit_says_which_pages_were_checked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(file_text_module, "_PDF_PAGE_LIMIT", 1)
    file_text = extract_file_text(_pdf("one", "two"), "application/pdf", "x.pdf")
    assert file_text.text is not None and "two" not in file_text.text
    assert file_text.checked_part == "the first 1 pages"


def test_a_pdf_is_read_without_walking_its_whole_page_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `reader.pages` counts every page before giving the first; a crafted
    # page tree makes that as slow as its author likes.
    def walk_everything(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("walked the whole page tree")

    monkeypatch.setattr(PdfReader, "_flatten", walk_everything)
    file_text = extract_file_text(
        _pdf("first page", "second page"), "application/pdf", "doc.pdf"
    )
    assert file_text.text is not None
    assert "first page" in file_text.text and "second page" in file_text.text


def test_a_pdf_page_inherits_its_fonts_from_the_page_tree() -> None:
    data = (
        _pdf("inherited font")
        .replace(b"/Resources << /Font << /F1 5 0 R >> >> ", b"")
        .replace(b"/Count 1 >>", b"/Count 1 /Resources << /Font << /F1 5 0 R >> >> >>")
    )
    file_text = extract_file_text(data, "application/pdf", "doc.pdf")
    assert file_text.text is not None and "inherited font" in file_text.text


async def test_a_document_that_takes_too_long_to_read_is_not_checked(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(file_text_module, "_WORKER_TIMEOUT_SECONDS", 0)
    client = _ContentTrustClient()
    with caplog.at_level(logging.WARNING):
        verdict = await check_attachments(
            client,  # type: ignore[arg-type]
            role="user",
            files=[(_pdf("FORBIDDEN"), "slow.pdf", "application/pdf")],
            room_id="room-1",
        )
    assert not verdict.blocked
    assert verdict.notes == (
        "⚠️ _Switch Trust did not check slow.pdf (it took too long to read)._",
    )
    assert client.checked == []
    assert "took longer than" in caplog.text


async def test_documents_are_read_in_a_worker_process() -> None:
    word = await read_file_text(_docx("the body"), _DOCX_TYPE, "memo.docx")
    pdf = await read_file_text(_pdf("a page"), "application/pdf", "doc.pdf")
    assert word.text is not None and "the body" in word.text
    assert pdf.text is not None and "a page" in pdf.text


@pytest.mark.skipif(
    not sys.platform.startswith("linux"), reason="only Linux caps address space"
)
async def test_a_document_that_needs_too_much_memory_is_not_checked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(file_text_module, "_WORKER_MEMORY_BYTES", 1024 * 1024)
    file_text = await read_file_text(
        _pdf("x" * 2_000_000), "application/pdf", "doc.pdf"
    )
    assert file_text.text is None
    assert file_text.unreadable_reason == "it could not be read within Switch's limits"


async def test_blocked_text_inside_a_word_document_or_a_pdf_blocks() -> None:
    client = _ContentTrustClient()
    verdict = await check_attachments(
        client,  # type: ignore[arg-type]
        role="user",
        files=[
            (_docx("FORBIDDEN plan"), "plan.docx", _DOCX_TYPE),
            (_pdf("FORBIDDEN report"), "report.pdf", "application/pdf"),
        ],
        room_id="room-1",
    )
    assert verdict.blocked
    reasons = " ".join(verdict.block_reasons)
    assert "plan.docx was blocked" in reasons
    assert "report.pdf was blocked" in reasons


async def test_a_scanned_pdf_is_relayed_with_a_not_checked_note() -> None:
    verdict = await check_attachments(
        _ContentTrustClient(),  # type: ignore[arg-type]
        role="user",
        files=[(_pdf(None), "scan.pdf", "application/pdf")],
        room_id="room-1",
    )
    assert not verdict.blocked
    [note] = verdict.notes
    assert "did not check scan.pdf" in note


def _docx_with(document_xml: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", document_xml)
    return buffer.getvalue()


def test_a_dtd_split_across_read_chunks_is_still_refused() -> None:
    chunk = 64 * 1024
    body = (
        f'<w:document xmlns:w="{_W_NS}"><w:body><w:p><w:r><w:t>&a;</w:t>'
        "</w:r></w:p></w:body></w:document>"
    ).encode()
    head = b'<?xml version="1.0"?>\n'
    head += b" " * (chunk - len(head) - 4) + b"<!DOCTYPE w:document ["
    head += b" " * (2 * chunk - len(head) - 4) + b'<!ENTITY a "secret">]>' + body
    assert b"<!DOCTYPE" not in head[:chunk]
    assert b"<!ENTITY" not in head[chunk : 2 * chunk]
    file_text = extract_file_text(_docx_with(head), _DOCX_TYPE, "evil.docx")
    assert file_text.text is None


def test_a_dtd_in_utf16_is_still_refused() -> None:
    document = (
        '<?xml version="1.0" encoding="UTF-16"?>'
        '<!DOCTYPE w:document [<!ENTITY a "secret">]>'
        f'<w:document xmlns:w="{_W_NS}"><w:body><w:p><w:r><w:t>&a;</w:t>'
        "</w:r></w:p></w:body></w:document>"
    ).encode("utf-16")
    file_text = extract_file_text(_docx_with(document), _DOCX_TYPE, "evil.docx")
    assert file_text.text is None
