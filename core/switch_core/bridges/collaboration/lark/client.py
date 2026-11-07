"""The slice of Lark's Open Platform API the Lark bridge uses, and its webhook crypto.

Lark and Feishu are one product on two hosts: Lark for tenants outside China
(open.larksuite.com), Feishu inside it (open.feishu.cn). The API, the event
shapes and the crypto are the same on both, so one client serves either and
the region only picks the host.

Every call is made with a tenant access token, minted from the app's id and
secret and kept until shortly before Lark says it expires. Lark answers most
failures with HTTP 200 and a nonzero `code`, so the code is what is checked.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from typing import Any, Literal

import httpx
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

Region = Literal["lark", "feishu"]

HOSTS: dict[Region, str] = {
    "lark": "https://open.larksuite.com",
    "feishu": "https://open.feishu.cn",
}

# Lark says how long a token lives (two hours); it is renewed this many
# seconds early so a call never goes out on one that expires mid-flight.
_TOKEN_MARGIN = 300

# Codes Lark answers a call with when the tenant token itself is the problem:
# expired, or revoked by a secret rotation. The token is minted again and the
# call made once more.
_TOKEN_INVALID = frozenset({99991661, 99991663, 99991668})

_TIMEOUT = httpx.Timeout(15.0, connect=10.0)


class LarkApiError(Exception):
    """Lark refused a call, with its own code and explanation.

    `auth` marks a refusal of the app's credentials themselves (a wrong app id
    or secret), which the bridge reports as such rather than as a refused
    operation.
    """

    def __init__(self, message: str, *, code: int, auth: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.auth = auth


class LarkClient:
    def __init__(
        self,
        *,
        region: Region,
        app_id: str,
        app_secret: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._app_id = app_id
        self._app_secret = app_secret
        self._http = httpx.AsyncClient(
            base_url=HOSTS[region], timeout=_TIMEOUT, transport=transport
        )
        self._token: str | None = None
        self._token_expires = 0.0

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _tenant_token(self) -> str:
        if self._token is not None and time.monotonic() < self._token_expires:
            return self._token
        response = await self._http.post(
            "/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": self._app_id, "app_secret": self._app_secret},
        )
        body = _json_body(response)
        code = int(body.get("code", -1))
        if code != 0 or not body.get("tenant_access_token"):
            raise LarkApiError(
                f"Lark refused the app credentials: {body.get('msg') or response.status_code} "
                f"(code {code})",
                code=code,
                auth=True,
            )
        self._token = str(body["tenant_access_token"])
        self._token_expires = (
            time.monotonic() + int(body.get("expire", 7200)) - _TOKEN_MARGIN
        )
        return self._token

    async def call(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        data: dict[str, str] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> dict[str, Any]:
        """Make one API call and return its `data`, raising `LarkApiError` on a refusal."""
        for attempt in (1, 2):
            token = await self._tenant_token()
            response = await self._http.request(
                method,
                path,
                json=json_body,
                params=params,
                data=data,
                files=files,
                headers={"Authorization": f"Bearer {token}"},
            )
            body = _json_body(response)
            code = int(body.get("code", -1))
            if code in _TOKEN_INVALID and attempt == 1:
                self._token = None
                continue
            if code != 0:
                raise LarkApiError(
                    f"Lark refused {method} {path}: {body.get('msg') or response.status_code} "
                    f"(code {code})",
                    code=code,
                )
            # Most calls answer under `data`; a few (bot info) at the top level.
            result = body.get("data")
            return result if isinstance(result, dict) else body
        raise AssertionError("unreachable")

    async def download(self, path: str, *, params: dict[str, str], limit: int) -> bytes:
        """Fetch a file's bytes, refusing one larger than `limit` without reading it all."""
        token = await self._tenant_token()
        async with self._http.stream(
            "GET", path, params=params, headers={"Authorization": f"Bearer {token}"}
        ) as response:
            if response.status_code != 200:
                await response.aread()
                body = _json_body(response)
                raise LarkApiError(
                    f"Lark refused the download of {path}: "
                    f"{body.get('msg') or response.status_code}",
                    code=int(body.get("code", -1)),
                )
            declared = response.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > limit:
                raise FileTooLarge(int(declared))
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > limit:
                    raise FileTooLarge(size)
                chunks.append(chunk)
            return b"".join(chunks)


class FileTooLarge(Exception):
    def __init__(self, size: int) -> None:
        super().__init__(f"{size} bytes")
        self.size = size


def new_send_key() -> str:
    """An idempotency key for one send: Lark posts a message once per key per hour."""
    return str(uuid.uuid4())


def _json_body(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {"code": -1, "msg": f"HTTP {response.status_code}, not JSON"}
    return body if isinstance(body, dict) else {"code": -1, "msg": "not an object"}


# ── Webhook crypto ────────────────────────────────────────────────────────────


def signature(timestamp: str, nonce: str, encrypt_key: str, body: bytes) -> str:
    """What Lark puts in `X-Lark-Signature`: sha256 over timestamp, nonce, key and body."""
    return hashlib.sha256((timestamp + nonce + encrypt_key).encode() + body).hexdigest()


def signature_matches(given: str, expected: str) -> bool:
    return hmac.compare_digest(given.encode(), expected.encode())


def decrypt(encrypted: str, encrypt_key: str) -> bytes:
    """Open an `encrypt` field: AES-256-CBC keyed by sha256(Encrypt Key), IV first, PKCS#7.

    Raises ValueError for anything that is not a well-formed ciphertext under
    this key.
    """
    raw = base64.b64decode(encrypted, validate=True)
    if len(raw) < 32 or len(raw) % 16:
        raise ValueError("ciphertext has the wrong length")
    key = hashlib.sha256(encrypt_key.encode()).digest()
    decryptor = Cipher(algorithms.AES(key), modes.CBC(raw[:16])).decryptor()
    padded = decryptor.update(raw[16:]) + decryptor.finalize()
    pad = padded[-1]
    if not 1 <= pad <= 16 or padded[-pad:] != bytes([pad]) * pad:
        raise ValueError("ciphertext padding is wrong")
    return padded[:-pad]


def open_envelope(body: bytes, encrypt_key: str) -> dict[str, Any]:
    """The event inside a delivery body, decrypted. ValueError if it is not one."""
    outer = json.loads(body)
    if not isinstance(outer, dict) or not isinstance(outer.get("encrypt"), str):
        raise ValueError("delivery is not encrypted")
    inner = json.loads(decrypt(outer["encrypt"], encrypt_key))
    if not isinstance(inner, dict):
        raise ValueError("event is not an object")
    return inner
