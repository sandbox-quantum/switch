"""The Mattermost driver verifies TLS by default (security fix).

_create_driver used to hardcode ``verify=False`` for every driver, so the admin
password and bot tokens were sent over an unverified https connection. TLS
verification now defaults on, with an explicit opt-out for a trusted self-signed
CA.
"""

from __future__ import annotations

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


def _adapter(**overrides: object) -> MattermostAdapter:
    cfg = MattermostConnectionConfig(
        url="https://mm.example",
        admin_user="a",
        admin_password="p",
        team_name="t",
        **overrides,  # type: ignore[arg-type]
    )
    return MattermostAdapter(config=cfg)


def test_tls_verification_on_by_default() -> None:
    assert _adapter()._create_driver().options["verify"] is True


def test_tls_verification_can_be_opted_out() -> None:
    assert _adapter(verify_tls=False)._create_driver().options["verify"] is False
