"""Defaults a deployment gets by setting nothing.

Both fail towards the hosted deployment: a local http stack opts out of Secure
cookies, and a server whose migrations run elsewhere opts out of migrating.
"""

from __future__ import annotations

from switch_core.config import SwitchConfig


def test_auth_cookies_are_secure_unless_turned_off() -> None:
    assert SwitchConfig.model_fields["gateway_cookie_secure"].default is True


def test_the_server_migrates_at_boot_unless_turned_off() -> None:
    assert SwitchConfig.model_fields["db_migrate_on_boot"].default is True
