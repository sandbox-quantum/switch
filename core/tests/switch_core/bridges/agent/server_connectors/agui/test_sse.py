"""SSE decoding: frame boundaries have nothing to do with chunk boundaries."""

from __future__ import annotations

import pytest

from switch_core.bridges.agent.server_connectors.agui.events import MalformedEventError
from switch_core.bridges.agent.server_connectors.agui.sse import (
    SseDecoder,
    decode_json_frame,
)


def test_single_frame() -> None:
    decoder = SseDecoder()
    assert decoder.feed('data: {"type":"RUN_STARTED"}\n\n') == [
        '{"type":"RUN_STARTED"}'
    ]


def test_two_frames_in_one_chunk() -> None:
    decoder = SseDecoder()
    payloads = decoder.feed('data: {"a":1}\n\ndata: {"b":2}\n\n')
    assert payloads == ['{"a":1}', '{"b":2}']


def test_frame_split_across_chunks() -> None:
    # The realistic case: a JSON event arrives in pieces that respect nothing.
    decoder = SseDecoder()
    assert decoder.feed('data: {"ty') == []
    assert decoder.feed('pe":"RUN_ST') == []
    assert decoder.feed('ARTED"}') == []
    assert decoder.feed("\n") == []
    assert decoder.feed("\n") == ['{"type":"RUN_STARTED"}']


def test_split_mid_newline_pair() -> None:
    decoder = SseDecoder()
    assert decoder.feed('data: {"a":1}\n') == []
    assert decoder.feed('\ndata: {"b":2}\n\n') == ['{"a":1}', '{"b":2}']


def test_crlf_line_endings() -> None:
    decoder = SseDecoder()
    assert decoder.feed('data: {"a":1}\r\n\r\n') == ['{"a":1}']


def test_data_without_leading_space() -> None:
    decoder = SseDecoder()
    assert decoder.feed('data:{"a":1}\n\n') == ['{"a":1}']


def test_multiple_data_lines_join_with_newline() -> None:
    decoder = SseDecoder()
    assert decoder.feed("data: line one\ndata: line two\n\n") == ["line one\nline two"]


def test_comment_lines_are_ignored() -> None:
    # Comments are how a producer keeps a connection warm. The protocol defines
    # no keepalive event, so this is the only thing standing between a thinking
    # model and a read timeout.
    decoder = SseDecoder()
    assert decoder.feed(": keepalive\n\n") == []
    assert decoder.feed(': ping\ndata: {"a":1}\n\n') == ['{"a":1}']


def test_non_data_fields_are_ignored() -> None:
    decoder = SseDecoder()
    payloads = decoder.feed('event: message\nid: 7\nretry: 1000\ndata: {"a":1}\n\n')
    assert payloads == ['{"a":1}']


def test_blank_line_without_data_emits_nothing() -> None:
    decoder = SseDecoder()
    assert decoder.feed("\n\n\n") == []


def test_close_flushes_unterminated_frame() -> None:
    # A cut stream may not terminate its last frame. Surfacing the partial run
    # is what lets the layer above call it incomplete; swallowing it here would
    # make a truncated run look like a short one.
    decoder = SseDecoder()
    assert decoder.feed('data: {"a":1}\n') == []
    assert decoder.close() == ['{"a":1}']


def test_close_flushes_frame_with_no_trailing_newline_at_all() -> None:
    decoder = SseDecoder()
    assert decoder.feed('data: {"a":1}') == []
    assert decoder.close() == ['{"a":1}']


def test_close_is_empty_when_nothing_pending() -> None:
    decoder = SseDecoder()
    assert decoder.feed('data: {"a":1}\n\n') == ['{"a":1}']
    assert decoder.close() == []


def test_decode_json_frame_parses() -> None:
    assert decode_json_frame('{"type":"RUN_STARTED"}') == {"type": "RUN_STARTED"}


def test_decode_json_frame_raises_on_garbage() -> None:
    with pytest.raises(MalformedEventError, match="not valid JSON"):
        decode_json_frame("{not json")
