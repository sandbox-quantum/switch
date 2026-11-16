"""The sign-in limits' settings at their defaults, for a test's
stand-in config (`gateway/login_limits.py` reads them on every sign-in)."""

from __future__ import annotations

from switch_core.config import SwitchConfig

LOGIN_LIMIT_DEFAULTS = {
    name: SwitchConfig.model_fields[name].default
    for name in (
        "gateway_login_max_failures",
        "gateway_login_max_failures_per_address",
        "gateway_login_failure_window_minutes",
        "gateway_login_lock_minutes",
    )
}
