"""`management_port()` sees agent management as off for a workspace it isn't turned on for (`management_tenant_ids`),
so a person's template run (`gateway/rooms.py`) or an agent's context can't list machines or create managed agents
there. No database: the port is a stand-in and the rule a list."""

from __future__ import annotations

from switch_core.bridges.agent.operations.agent_management import (
    WORKSPACE_NOT_ENABLED_MESSAGE,
    disable_agent_management,
    enable_agent_management,
    management_off_reason,
    management_port,
)
from switch_core.tenant_context import tenant_scope


def test_the_port_is_off_for_a_workspace_management_isnt_on_for():
    port = object()
    enable_agent_management(port, lambda tenant_id: tenant_id == "on")  # type: ignore[arg-type]
    try:
        with tenant_scope("on"):
            assert management_port() is port
        with tenant_scope("off"):
            assert management_port() is None
    finally:
        disable_agent_management()


def test_with_no_rule_every_workspace_sees_it_as_before():
    port = object()
    enable_agent_management(port)  # type: ignore[arg-type]
    try:
        with tenant_scope("any"):
            assert management_port() is port
    finally:
        disable_agent_management()
    assert management_port() is None  # and disabling clears the rule with the port


def test_with_a_list_set_a_call_with_no_workspace_bound_sees_it_off():
    """Fail closed. Every caller today has a workspace bound; this guards any later one that doesn't."""
    port = object()
    enable_agent_management(port, lambda _tenant_id: True, restricted=True)  # type: ignore[arg-type]
    try:
        assert management_port() is None  # nothing bound in a plain test
        with tenant_scope("any"):
            assert management_port() is port
    finally:
        disable_agent_management()
    enable_agent_management(port)  # type: ignore[arg-type]
    try:
        assert management_port() is port  # no list: as before
    finally:
        disable_agent_management()


def test_the_reason_names_the_workspace_when_management_runs_here():
    assert "not turned on here" in management_off_reason()
    enable_agent_management(object(), lambda _tenant_id: False, restricted=True)  # type: ignore[arg-type]
    try:
        assert management_off_reason() == WORKSPACE_NOT_ENABLED_MESSAGE
    finally:
        disable_agent_management()
