"""Who may use a route, as the status each `Persona` must be answered with.

A rule names the people it lets through; everyone else is refused with the
status the route refuses with. "Let through" is a set: the route's own success,
or 418, which `harness.Reached` answers once a route passed its checks and
asked something the matrix stands in for. A refusal is one exact status.
"""

from __future__ import annotations

from tests.switch_core.gateway.role_matrix.harness import Persona

Expected = int | frozenset[int]

# Passed its checks: answered, or went on to something the matrix stands in for.
REACHED = 418
OK = frozenset({200, 201, 202, 204, REACHED})

ADMINS = frozenset({Persona.ORG_ADMIN, Persona.WORKSPACE_ADMIN, Persona.OPERATOR})


def _rule(
    allowed: frozenset[Persona], ok: Expected, refused: int
) -> dict[Persona, Expected]:
    return {persona: ok if persona in allowed else refused for persona in Persona}


def anyone(ok: Expected = OK) -> dict[Persona, Expected]:
    """Anyone who may enter the workspace, the operator included."""
    return {persona: ok for persona in Persona}


def admins(ok: Expected = OK, refused: int = 403) -> dict[Persona, Expected]:
    """Whoever administers the workspace: its admins by membership, its
    organization's admin, and the operator."""
    return _rule(ADMINS, ok, refused)


def owner_or_admins(ok: Expected = OK, refused: int = 403) -> dict[Persona, Expected]:
    return _rule(ADMINS | {Persona.OWNER}, ok, refused)


def owner(ok: Expected = OK, refused: int = 404) -> dict[Persona, Expected]:
    """Its owner alone, whatever anyone else administers."""
    return _rule(frozenset({Persona.OWNER}), ok, refused)


def org_admin(ok: Expected = OK, refused: int = 403) -> dict[Persona, Expected]:
    """The organization's admin. The operator restores one only while the
    organization has none, and this one has."""
    return _rule(frozenset({Persona.ORG_ADMIN}), ok, refused)


def operator(ok: Expected = OK, refused: int = 403) -> dict[Persona, Expected]:
    return _rule(frozenset({Persona.OPERATOR}), ok, refused)


def admin_by_membership(
    ok: Expected = OK, refused: int = 403
) -> dict[Persona, Expected]:
    """An admin of the workspace by their own membership, not by the
    organization or the operator bit."""
    return _rule(frozenset({Persona.WORKSPACE_ADMIN}), ok, refused)


def matches(expected: Expected, status: int) -> bool:
    return status in expected if isinstance(expected, frozenset) else status == expected
