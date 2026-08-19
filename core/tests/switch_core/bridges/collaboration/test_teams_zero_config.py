"""Values Switch generates for a Teams bridge, and the save-time credential check."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
)
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.bridges.collaboration.teams.crypto import (
    generate_encryption_keypair,
    load_certificate_der_b64,
)


def _raw_config(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "app_id": "app-id",
        "app_password": "app-password",
        "tenant_id": "tenant-id",
        "team_id": "team-id",
        "public_base_url": "https://teams.example.com",
    }
    base.update(overrides)
    return base


# ── Generated values ─────────────────────────────────────────────────────────


def test_client_state_is_generated_and_unguessable() -> None:
    first = TeamsAdapter.prepare_config(_raw_config())
    second = TeamsAdapter.prepare_config(_raw_config())

    assert len(str(first["client_state"])) >= 32
    assert first["client_state"] != second["client_state"]


def test_client_state_supplied_by_caller_wins() -> None:
    prepared = TeamsAdapter.prepare_config(_raw_config(client_state="mine"))

    assert prepared["client_state"] == "mine"


def test_a_config_with_no_client_state_is_rejected_not_filled_in() -> None:
    """Silently minting one would break every live subscription's origin check."""
    with pytest.raises(ValidationError, match="client_state"):
        TeamsConnectionConfig.model_validate(_raw_config())


def test_prepare_config_generates_a_usable_encryption_trio() -> None:
    prepared = TeamsAdapter.prepare_config(_raw_config())

    assert prepared["encryption_certificate_id"]
    # The certificate has to survive the exact round trip the subscription path
    # puts it through, and the private key has to parse.
    assert load_certificate_der_b64(str(prepared["encryption_public_certificate"]))
    assert load_pem_private_key(
        str(prepared["encryption_private_key"]).encode(), password=None
    )


def test_generated_certificate_matches_its_private_key() -> None:
    cert_pem, key_pem = generate_encryption_keypair()

    cert = x509.load_pem_x509_certificate(cert_pem.encode())
    key = load_pem_private_key(key_pem.encode(), password=None)

    assert cert.public_key().public_numbers() == key.public_key().public_numbers()


def test_prepare_config_leaves_a_supplied_trio_alone() -> None:
    cert_pem, key_pem = generate_encryption_keypair()
    prepared = TeamsAdapter.prepare_config(
        _raw_config(
            encryption_certificate_id="mine",
            encryption_public_certificate=cert_pem,
            encryption_private_key=key_pem,
        )
    )

    assert prepared["encryption_certificate_id"] == "mine"
    assert prepared["encryption_public_certificate"] == cert_pem


def test_prepare_config_does_not_mutate_its_argument() -> None:
    raw = _raw_config()
    TeamsAdapter.prepare_config(raw)

    assert "encryption_private_key" not in raw


def test_validating_a_stored_config_never_regenerates_key_material() -> None:
    """The pair is minted once, at registration.

    Regenerating on every validate would mean a fresh certificate each restart
    while Graph kept encrypting to the previous one, and capture would fail to
    decrypt with nothing to point at.
    """
    stored = TeamsAdapter.prepare_config(_raw_config())

    first = TeamsConnectionConfig.model_validate(stored)
    second = TeamsConnectionConfig.model_validate(stored)

    assert first.encryption_private_key == second.encryption_private_key
    assert first.client_state == second.client_state


def test_a_config_with_no_encryption_material_stays_empty() -> None:
    """A bridge registered before generation existed keeps its degraded state.

    Filling it in here would silently pair it with a certificate Graph was never
    told about.
    """
    config = TeamsConnectionConfig.model_validate(_raw_config(client_state="s"))

    assert config.encryption_private_key is None
    assert config.encryption_public_certificate is None


def test_half_an_encryption_trio_is_rejected() -> None:
    cert_pem, _ = generate_encryption_keypair()

    with pytest.raises(ValidationError, match="must be supplied together"):
        TeamsConnectionConfig.model_validate(
            _raw_config(client_state="s", encryption_public_certificate=cert_pem)
        )


# ── Save-time credential verification ────────────────────────────────────────


class _FakeHttp:
    """Stands in for httpx.AsyncClient as an async context manager."""

    def __init__(self, status: int, body: Any) -> None:
        self.status = status
        self.body = body
        self.calls: list[str] = []

    async def __aenter__(self) -> _FakeHttp:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def post(self, url: str, data: dict[str, str]) -> httpx.Response:
        self.calls.append(data["scope"])
        return httpx.Response(
            status_code=self.status,
            json=self.body,
            request=httpx.Request("POST", url),
        )


@pytest.fixture
def fake_http(monkeypatch: pytest.MonkeyPatch) -> Any:
    def _install(status: int, body: Any) -> _FakeHttp:
        client = _FakeHttp(status, body)
        monkeypatch.setattr(
            "switch_core.bridges.collaboration.teams.adapter.httpx.AsyncClient",
            lambda **_: client,
        )
        return client

    return _install


async def test_verify_credentials_requests_both_scopes(fake_http: Any) -> None:
    client = fake_http(200, {"access_token": "tok", "expires_in": 3600})

    await TeamsAdapter.verify_credentials(TeamsAdapter.prepare_config(_raw_config()))

    assert client.calls == [
        "https://graph.microsoft.com/.default",
        "https://api.botframework.com/.default",
    ]


async def test_verify_credentials_surfaces_the_secret_id_mistake(
    fake_http: Any,
) -> None:
    """The failure that cost this the most time must reach the operator intact."""
    fake_http(
        401,
        {
            "error": "invalid_client",
            "error_description": (
                "AADSTS7000215: Invalid client secret provided. Ensure the secret "
                "being sent in the request is the client secret value, not the "
                "client secret ID, for a secret added to app 'abc'. "
                "Trace ID: 1234 Correlation ID: 5678"
            ),
        },
    )

    with pytest.raises(BridgeCredentialError) as excinfo:
        await TeamsAdapter.verify_credentials(_raw_config(client_state="s"))

    message = str(excinfo.value)
    assert "not the client secret ID" in message
    # The trace and correlation ids are noise to the person reading a form error.
    assert "Trace ID" not in message


async def test_verify_credentials_keeps_an_unparseable_body(fake_http: Any) -> None:
    fake_http(500, "upstream exploded")

    with pytest.raises(BridgeCredentialError, match="upstream exploded"):
        await TeamsAdapter.verify_credentials(_raw_config(client_state="s"))


async def test_verify_credentials_reports_an_unreachable_microsoft(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Unreachable(_FakeHttp):
        async def post(self, url: str, data: dict[str, str]) -> httpx.Response:
            raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.teams.adapter.httpx.AsyncClient",
        lambda **_: _Unreachable(200, {}),
    )

    with pytest.raises(BridgeCredentialError, match="Could not reach Microsoft"):
        await TeamsAdapter.verify_credentials(_raw_config(client_state="s"))


# ── register() wiring ────────────────────────────────────────────────────────


class _RecordingAdapter(CollaborationAdapter):
    """Records the order register() drives the two hooks in."""

    events: list[str] = []
    seen_config: dict[str, object] = {}
    fail_verification = False

    @classmethod
    def prepare_config(cls, connection_config: dict[str, object]) -> dict[str, object]:
        cls.events.append("prepare")
        return {**connection_config, "generated": "yes"}

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        cls.events.append("verify")
        cls.seen_config = dict(connection_config)
        if cls.fail_verification:
            raise BridgeCredentialError("platform said no")

    async def start(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        raise AssertionError("start must not run when verification fails")

    async def stop(self) -> None:  # pragma: no cover
        return None

    async def send_message(self, *args: Any, **kwargs: Any) -> str | None:
        return None

    async def create_channel(self, *args: Any, **kwargs: Any) -> str:
        return "c"

    async def get_channel_type(self, *args: Any, **kwargs: Any) -> Any:
        return None

    async def add_agents_to_channel(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def add_users_to_channel(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def create_agent_identity(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def remove_agent_identity(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def get_channel_agent_names(self, *args: Any, **kwargs: Any) -> list[str]:
        return []


class _RecordingConfig(BridgeConnectionConfig):
    app_id: str
    generated: str


def _lifecycle() -> CollaborationBridgeLifecycleService:
    service = CollaborationBridgeLifecycleService(
        bridge_store=MagicMock(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
        room_store=MagicMock(),
        agent_store=MagicMock(),
        client_store=MagicMock(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        matrix_admin=MagicMock(),
        session_factory=MagicMock(),
        config=MagicMock(),
    )
    service.register_adapter("recording", _RecordingAdapter, _RecordingConfig)
    return service


async def test_register_prepares_then_verifies_before_touching_anything() -> None:
    """Verification has to precede the Matrix identity and the DB write.

    Otherwise a bridge that was never viable still leaves an orphan client
    behind, and the row has to be cleaned up by hand.
    """
    _RecordingAdapter.events = []
    _RecordingAdapter.fail_verification = True
    service = _lifecycle()

    with pytest.raises(BridgeCredentialError, match="platform said no"):
        await service.register(
            bridge_type="recording",
            display_name="Recording",
            connection_config={"app_id": "a"},
        )

    assert _RecordingAdapter.events == ["prepare", "verify"]
    # No Matrix identity was minted for a bridge that cannot work.
    service._client_lifecycle.create_client.assert_not_called()  # type: ignore[attr-defined]


async def test_register_verifies_the_prepared_config_not_the_raw_request() -> None:
    """A generated credential must be the one that gets checked."""
    _RecordingAdapter.events = []
    _RecordingAdapter.fail_verification = True
    service = _lifecycle()

    with pytest.raises(BridgeCredentialError):
        await service.register(
            bridge_type="recording",
            display_name="Recording",
            connection_config={"app_id": "a"},
        )

    assert _RecordingAdapter.seen_config["generated"] == "yes"
