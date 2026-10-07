"""Writes sealed-vector.json: logins sealed as Core seals them, for sealed-logins.test.ts.

Run from this directory:
    uv run --no-project --with cryptography python make_sealed_vector.py
Every key, id and credential here is a test placeholder.
"""

import base64
import json

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DATA_KEY = bytes(range(32))
ENCRYPTED_KEY = b"wrapped-data-key-placeholder"
KEY_ARN = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000"


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode()


def additional_data(context: dict[str, str], revision: int) -> bytes:
    return json.dumps(
        {"context": context, "revision": revision},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def seal(
    provider: str,
    kind: str,
    credential: str,
    revision: int,
    context: dict[str, str],
    iv: bytes,
) -> dict:
    plaintext = json.dumps(
        {
            "status": "connected",
            "revision": str(revision),
            "provider": provider,
            "kind": kind,
            "credential": credential,
        },
        separators=(",", ":"),
    ).encode()
    aad = additional_data(context, revision)
    sealed = AESGCM(DATA_KEY).encrypt(iv, plaintext, aad)
    return {
        "aad": aad.decode(),
        "envelope": {
            "v": 1,
            "provider": provider,
            "revision": revision,
            "status": "connected",
            "key_arn": KEY_ARN,
            "encrypted_key": b64(ENCRYPTED_KEY),
            "iv": b64(iv),
            "ciphertext": b64(sealed[:-16]),
            "tag": b64(sealed[-16:]),
            "context": context,
        },
    }


def context(provider: str, tenant: str) -> dict[str, str]:
    return {
        "switch:tenant": tenant,
        "switch:owner_id": "owner-1",
        "switch:controller_id": "ctl-1",
        "switch:provider": provider,
    }


vector = {
    "dataKey": b64(DATA_KEY),
    "encryptedKey": b64(ENCRYPTED_KEY),
    "keyArn": KEY_ARN,
    "cases": {
        "claude": seal(
            "claude",
            "api-key",
            "sk-ant-test-placeholder",
            3,
            context("claude", "tenant-1"),
            bytes(range(12)),
        ),
        "claudeNext": seal(
            "claude",
            "api-key",
            "sk-ant-test-placeholder-2",
            4,
            context("claude", "tenant-1"),
            bytes(range(1, 13)),
        ),
        "codex": seal(
            "codex",
            "auth-json",
            '{"tokens":{"access_token":"placeholder"}}',
            7,
            context("codex", "tenant-1"),
            bytes(range(2, 14)),
        ),
        "unicode": seal(
            "claude",
            "setup-token",
            "sk-ant-oat-placeholder",
            12,
            context("claude", "ténant-ü-\U0001f600"),
            bytes(range(3, 15)),
        ),
    },
}

with open("sealed-vector.json", "w") as out:
    json.dump(vector, out, indent=2)
    out.write("\n")
