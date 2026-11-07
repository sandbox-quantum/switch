"""Lark's long connection, frame by frame.

The app asks Lark's open platform for a WebSocket address with its App ID and
App Secret (`POST /callback/ws/endpoint`), and Lark then pushes events over
that socket instead of calling a public URL. Each WebSocket message is one
protobuf `Frame`:

    message Header { string key = 1; string value = 2; }
    message Frame {
      uint64 SeqID = 1; uint64 LogID = 2; int32 service = 3; int32 method = 4;
      repeated Header headers = 5; string payload_encoding = 6;
      string payload_type = 7; bytes payload = 8; string LogIDNew = 9;
    }

`method` 0 is control (the client's `ping`, Lark's `pong`), 1 is data (an
`event` or a `card` press). A data frame is acknowledged by sending it back
with a JSON payload `{"code": 200}`; a large event comes in `sum` parts that
share a `message_id`, numbered by `seq`.

Only the fields used are written, and unknown ones are skipped on reading, so
this needs no protobuf library.
"""

from __future__ import annotations

from dataclasses import dataclass, field

CONTROL = 0
DATA = 1


class FrameError(ValueError):
    """A WebSocket message that is not a frame."""


@dataclass
class Frame:
    seq_id: int = 0
    log_id: int = 0
    service: int = 0
    method: int = CONTROL
    headers: list[tuple[str, str]] = field(default_factory=list)
    payload: bytes | None = None

    def header(self, key: str) -> str | None:
        for name, value in self.headers:
            if name == key:
                return value
        return None


def _varint(value: int) -> bytes:
    if value < 0:
        value += 1 << 64
    out = bytearray()
    while True:
        low = value & 0x7F
        value >>= 7
        if value:
            out.append(low | 0x80)
        else:
            out.append(low)
            return bytes(out)


def _field(number: int, value: int | bytes) -> bytes:
    if isinstance(value, int):
        return _varint(number << 3) + _varint(value)
    return _varint((number << 3) | 2) + _varint(len(value)) + value


def encode(frame: Frame) -> bytes:
    out = (
        _field(1, frame.seq_id)
        + _field(2, frame.log_id)
        + _field(3, frame.service)
        + _field(4, frame.method)
    )
    for key, value in frame.headers:
        out += _field(5, _field(1, key.encode()) + _field(2, value.encode()))
    if frame.payload is not None:
        out += _field(8, frame.payload)
    return out


def _read_varint(data: bytes, at: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        if at >= len(data) or shift > 63:
            raise FrameError("a number runs past the end of the frame")
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, at


def _fields(data: bytes) -> list[tuple[int, int | bytes]]:
    at, out = 0, []
    while at < len(data):
        key, at = _read_varint(data, at)
        number, wire = key >> 3, key & 7
        value: int | bytes
        if wire == 0:
            value, at = _read_varint(data, at)
        elif wire == 2:
            length, at = _read_varint(data, at)
            if at + length > len(data):
                raise FrameError("a field runs past the end of the frame")
            value, at = data[at : at + length], at + length
        elif wire == 1:
            value, at = data[at : at + 8], at + 8
        elif wire == 5:
            value, at = data[at : at + 4], at + 4
        else:
            raise FrameError(f"unknown wire type {wire}")
        out.append((number, value))
    return out


def decode(data: bytes) -> Frame:
    frame = Frame()
    for number, value in _fields(data):
        if number == 1 and isinstance(value, int):
            frame.seq_id = value
        elif number == 2 and isinstance(value, int):
            frame.log_id = value
        elif number == 3 and isinstance(value, int):
            frame.service = value
        elif number == 4 and isinstance(value, int):
            frame.method = value
        elif number == 5 and isinstance(value, bytes):
            pair = dict(_fields(value))
            key, text = pair.get(1, b""), pair.get(2, b"")
            if not isinstance(key, bytes) or not isinstance(text, bytes):
                raise FrameError("a header is not two strings")
            frame.headers.append((key.decode(), text.decode()))
        elif number == 8 and isinstance(value, bytes):
            frame.payload = value
    return frame


def ping(service: int) -> Frame:
    return Frame(service=service, method=CONTROL, headers=[("type", "ping")])


def acknowledge(frame: Frame, payload: bytes) -> Frame:
    """`frame` sent back, as Lark takes an answer to an event or a press."""
    return Frame(
        seq_id=frame.seq_id,
        log_id=frame.log_id,
        service=frame.service,
        method=frame.method,
        headers=[*frame.headers, ("biz_rt", "0")],
        payload=payload,
    )
