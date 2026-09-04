"""CHOO-2067 — channel capture must survive a subscription that fails once.

Graph validates a notification URL by calling it, and a bridge asks for its
subscriptions within seconds of binding its port. Behind a load balancer that
is exactly when nothing answers yet, so the first attempt after every restart
is refused. Capture then stayed dead for the life of the process — and it was a
restart that broke it, so restarting to fix it is a coin toss. Observed four
times in one afternoon on switch-dev.

The same loop covers a slower case: an app's Graph roles are fixed when its
token is issued, so consent granted while the bridge runs does nothing until
the token is replaced.
"""

from __future__ import annotations

import asyncio
import datetime
import functools
from collections.abc import Callable
from typing import Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from switch_core.bridges.collaboration.teams import adapter as adapter_module
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

_CHANNEL = "19:abc@thread.tacv2"


@functools.lru_cache(maxsize=1)
def _cert_pem() -> str:
    """A real self-signed certificate — the subscription path loads it before
    it calls Graph, so a placeholder would fail these tests for the wrong
    reason. Generated once for the module."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "switch-teams-test")])
    now = datetime.datetime(2026, 1, 1, tzinfo=datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def _config() -> TeamsConnectionConfig:
    return TeamsConnectionConfig(
        app_id="app-123",
        app_password="secret",
        tenant_id="tenant-1",
        team_id="team-1",
        public_base_url="https://switch.example",
        encryption_certificate_id="cert-1",
        encryption_public_certificate=_cert_pem(),
        encryption_private_key="unused — nothing here decrypts a notification",
        client_state="s3cr3t",
    )


class _Graph:
    """A Graph stub whose subscription call fails a set number of times."""

    def __init__(self, *, failures: int, error: Exception | None = None) -> None:
        self._remaining = failures
        self._error = error or RuntimeError(
            "ServiceUnavailable from the notification endpoint"
        )
        self.attempts = 0

    async def create_subscription(self, **kwargs: Any) -> dict[str, Any]:
        self.attempts += 1
        if self._remaining > 0:
            self._remaining -= 1
            raise self._error
        return {"id": "sub-1"}


def _adapter(graph: _Graph) -> TeamsAdapter:
    adapter = TeamsAdapter(config=_config())
    adapter._graph = graph  # type: ignore[assignment]
    return adapter


async def test_a_failed_subscription_is_remembered_as_work_still_owed() -> None:
    adapter = _adapter(_Graph(failures=1))

    await adapter._ensure_channel_subscription(_CHANNEL)

    # Nothing captured yet — but the channel is not forgotten, which is what
    # let the old code drop it silently until the next restart.
    assert _CHANNEL not in adapter._subscriptions
    assert _CHANNEL in adapter._capture_wanted
    assert _CHANNEL in adapter._capture_failures


async def test_the_second_attempt_succeeds_once_the_endpoint_answers() -> None:
    graph = _Graph(failures=1)
    adapter = _adapter(graph)

    await adapter._ensure_channel_subscription(_CHANNEL)
    await adapter._ensure_channel_subscription(_CHANNEL)

    assert graph.attempts == 2
    assert adapter._subscriptions[_CHANNEL] == "sub-1"
    # The failure is cleared, so a later failure logs as new rather than as a
    # repeat of one that has since been fixed.
    assert _CHANNEL not in adapter._capture_failures


async def test_a_subscribed_channel_is_not_re_attempted() -> None:
    graph = _Graph(failures=0)
    adapter = _adapter(graph)

    await adapter._ensure_channel_subscription(_CHANNEL)
    await adapter._ensure_channel_subscription(_CHANNEL)

    assert graph.attempts == 1


async def test_a_missing_certificate_is_recorded_without_calling_graph() -> None:
    config = _config()
    config.encryption_public_certificate = None
    config.encryption_certificate_id = None
    graph = _Graph(failures=0)
    adapter = TeamsAdapter(config=config)
    adapter._graph = graph  # type: ignore[assignment]

    await adapter._ensure_channel_subscription(_CHANNEL)

    assert graph.attempts == 0
    assert "encryption certificate" in adapter._capture_failures[_CHANNEL]


async def test_repeat_failures_are_quiet_but_a_changed_reason_is_not(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The loop retries for the life of the process, so an unfixable channel must
    # not write the same error forever — while a 403 becoming a 400 is the
    # difference between a permission problem and an unreachable endpoint.
    adapter = _adapter(_Graph(failures=0))
    caplog.set_level("WARNING")

    adapter._note_capture_failure(_CHANNEL, "403 Forbidden")
    adapter._note_capture_failure(_CHANNEL, "403 Forbidden")
    first_pass = [r for r in caplog.records if r.levelname in ("ERROR", "WARNING")]
    assert len(first_pass) == 1
    assert first_pass[0].levelname == "ERROR"

    adapter._note_capture_failure(_CHANNEL, "400 ValidationError")
    second_pass = [r for r in caplog.records if r.levelname in ("ERROR", "WARNING")]
    assert len(second_pass) == 2
    assert second_pass[1].levelname == "WARNING"
    assert "400 ValidationError" in second_pass[1].getMessage()


async def test_recovery_is_announced(caplog: pytest.LogCaptureFixture) -> None:
    # A quiet recovery is nearly as bad as a quiet failure: the log said capture
    # was degraded and must say when it stopped being so.
    adapter = _adapter(_Graph(failures=1))
    await adapter._ensure_channel_subscription(_CHANNEL)
    caplog.set_level("INFO")

    await adapter._ensure_channel_subscription(_CHANNEL)

    assert any("Capture recovered" in r.getMessage() for r in caplog.records)


async def test_a_first_time_subscription_does_not_claim_to_have_recovered(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _adapter(_Graph(failures=0))
    caplog.set_level("INFO")

    await adapter._ensure_channel_subscription(_CHANNEL)

    messages = [r.getMessage() for r in caplog.records]
    assert any("Subscribed to" in m for m in messages)
    assert not any("Capture recovered" in m for m in messages)


async def _drive(adapter: TeamsAdapter, *, until: Callable[[], bool]) -> None:
    """Run the repair loop until a condition holds, then stop it."""
    task = asyncio.create_task(adapter._repair_loop())
    try:
        for _ in range(200):
            await asyncio.sleep(0.005)
            if until():
                return
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_the_loop_restores_capture_with_no_restart_and_no_operator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The whole point: the first attempt after a restart is refused because the
    # load balancer is not serving the new pod yet, and a minute later it is.
    monkeypatch.setattr(adapter_module, "_REPAIR_MIN_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(adapter_module, "_REPAIR_MAX_INTERVAL_SECONDS", 0.02)
    adapter = _adapter(_Graph(failures=1))

    await adapter._ensure_channel_subscription(_CHANNEL)
    assert _CHANNEL not in adapter._subscriptions

    await _drive(adapter, until=lambda: _CHANNEL in adapter._subscriptions)

    assert adapter._subscriptions[_CHANNEL] == "sub-1"


async def test_a_channel_that_never_recovers_is_still_being_tried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Backing off must not become giving up: the permission case can take an
    # hour to clear, long after any bounded number of attempts would have run
    # out.
    monkeypatch.setattr(adapter_module, "_REPAIR_MIN_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(adapter_module, "_REPAIR_MAX_INTERVAL_SECONDS", 0.02)
    graph = _Graph(failures=10_000)
    adapter = _adapter(graph)

    await adapter._ensure_channel_subscription(_CHANNEL)
    await _drive(adapter, until=lambda: graph.attempts >= 4)

    assert graph.attempts >= 4
    assert _CHANNEL in adapter._capture_wanted
