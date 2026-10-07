"""Sealing a provider login for an ec2 controller, with KMS stubbed.

`fixtures/sealed-vector.json` is the vector the controller's opener is tested
against too: these tests pin that Core produces it byte for byte from its
inputs, so the two sides cannot drift apart.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import ValidationError

from switch_core.management.schemas import SealedEnvelope
from switch_core.providers import sealing

VECTOR = json.loads(
    (Path(__file__).parent / "fixtures" / "sealed-vector.json").read_text()
)
KEY_ARN = "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000"
DATA_KEY = bytes(range(32))
ENCRYPTED_KEY = b"placeholder-kms-ciphertext-blob"


class FakeKms:
    """`generate_data_key` as boto3's KMS client answers it."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def generate_data_key(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {
            "Plaintext": DATA_KEY,
            "CiphertextBlob": ENCRYPTED_KEY,
            "KeyId": kwargs["KeyId"],
        }


@pytest.fixture
def kms(monkeypatch: pytest.MonkeyPatch) -> FakeKms:
    fake = FakeKms()
    monkeypatch.setattr(sealing, "kms_client", lambda region: fake)
    return fake


def _open(envelope: dict[str, Any], data_key: bytes) -> bytes:
    sealed = base64.b64decode(envelope["ciphertext"]) + base64.b64decode(
        envelope["tag"]
    )
    return AESGCM(data_key).decrypt(
        base64.b64decode(envelope["iv"]),
        sealed,
        sealing.additional_data(envelope["context"], envelope["revision"]),
    )


class TestTheVector:
    def test_core_reproduces_it(self) -> None:
        envelope = VECTOR["envelope"]
        context = sealing.login_context(
            "tenant-00000000", "owner-00000000", "controller-00000000", "codex"
        )
        plaintext = sealing.login_plaintext(
            "codex", "api-key", "sk-PLACEHOLDER-NOT-A-REAL-KEY", 3
        )
        assert plaintext.decode() == VECTOR["plaintext"]
        assert sealing.additional_data(context, 3).decode() == VECTOR["aad"]
        assert (
            sealing.seal_with_key(
                data_key=base64.b64decode(VECTOR["data_key"]),
                encrypted_key=ENCRYPTED_KEY,
                iv=base64.b64decode(envelope["iv"]),
                key_arn=KEY_ARN,
                provider="codex",
                revision=3,
                context=context,
                plaintext=plaintext,
            )
            == envelope
        )

    def test_it_opens_only_under_its_own_context_and_revision(self) -> None:
        envelope = VECTOR["envelope"]
        data_key = base64.b64decode(VECTOR["data_key"])
        assert _open(envelope, data_key).decode() == VECTOR["plaintext"]
        with pytest.raises(InvalidTag):
            _open({**envelope, "revision": 4}, data_key)
        with pytest.raises(InvalidTag):
            _open(
                {
                    **envelope,
                    "context": {
                        **envelope["context"],
                        "switch:controller_id": "controller-11111111",
                    },
                },
                data_key,
            )

    def test_it_is_a_valid_wire_envelope(self) -> None:
        envelope = VECTOR["envelope"]
        assert SealedEnvelope.model_validate(envelope).model_dump_wire() == envelope


class TestSeal:
    async def test_asks_kms_for_an_aes_256_key_under_the_context(
        self, kms: FakeKms
    ) -> None:
        context = sealing.login_context("t", "o", "c", "claude")
        plaintext = sealing.login_plaintext("claude", "oauth", "PLACEHOLDER", 2)
        envelope = await sealing.seal(
            sealing.KmsSettings(key_arn=KEY_ARN, region="us-east-1"),
            provider="claude",
            revision=2,
            context=context,
            plaintext=plaintext,
        )
        assert kms.calls == [
            {"KeyId": KEY_ARN, "KeySpec": "AES_256", "EncryptionContext": context}
        ]
        assert base64.b64decode(envelope["encrypted_key"]) == ENCRYPTED_KEY
        assert len(base64.b64decode(envelope["iv"])) == sealing.IV_BYTES
        assert len(base64.b64decode(envelope["tag"])) == sealing.TAG_BYTES
        assert _open(envelope, DATA_KEY) == plaintext
        SealedEnvelope.model_validate(envelope)

    async def test_every_seal_has_its_own_iv(self, kms: FakeKms) -> None:
        settings = sealing.KmsSettings(key_arn=KEY_ARN, region="us-east-1")
        context = sealing.login_context("t", "o", "c", "codex")
        ivs = {
            (
                await sealing.seal(
                    settings,
                    provider="codex",
                    revision=1,
                    context=context,
                    plaintext=b"{}",
                )
            )["iv"]
            for _ in range(4)
        }
        assert len(ivs) == 4

    def test_a_short_iv_is_refused(self) -> None:
        with pytest.raises(ValueError, match="12 bytes"):
            sealing.seal_with_key(
                data_key=DATA_KEY,
                encrypted_key=ENCRYPTED_KEY,
                iv=b"short",
                key_arn=KEY_ARN,
                provider="codex",
                revision=1,
                context=sealing.login_context("t", "o", "c", "codex"),
                plaintext=b"{}",
            )


class TestSettings:
    @pytest.mark.parametrize(
        ("key_arn", "region"),
        [(None, "us-east-1"), (KEY_ARN, None), (None, None)],
    )
    def test_an_unconfigured_key_is_an_error(
        self, key_arn: str | None, region: str | None
    ) -> None:
        config = SimpleNamespace(
            hosted_login_kms_key_arn=key_arn, hosted_login_kms_region=region
        )
        with pytest.raises(sealing.SealingNotConfigured):
            sealing.kms_settings(config)  # type: ignore[arg-type]


class TestTheEnvelopeSchema:
    def test_a_revoked_envelope_carries_no_key_material(self) -> None:
        context = sealing.login_context("t", "o", "c", "codex")
        revoked = sealing.revoked_envelope("codex", 5, context)
        assert SealedEnvelope.model_validate(revoked).model_dump_wire() == revoked
        with pytest.raises(ValidationError):
            SealedEnvelope.model_validate({**revoked, "iv": "AAAA"})

    def test_a_connected_envelope_carries_all_of_it(self) -> None:
        with pytest.raises(ValidationError):
            SealedEnvelope.model_validate({**VECTOR["envelope"], "tag": None})

    def test_the_context_names_the_envelopes_provider(self) -> None:
        envelope = VECTOR["envelope"]
        with pytest.raises(ValidationError):
            SealedEnvelope.model_validate(
                {
                    **envelope,
                    "context": {**envelope["context"], "switch:provider": "claude"},
                }
            )
