"""Every provisioning implementation must satisfy the port.

Structural conformance is not checked anywhere else: neither implementation
names the Protocol, and every caller annotates the port, so a signature
drifting apart from the contract would type-check on both sides and only fail
at the call. This is the same guard `test_no_nio_outside_transport.py` gives the
transport port, in the shape a Protocol allows.
"""

from __future__ import annotations

import inspect

import pytest

from switch_core.matrix_admin import MatrixAdmin
from switch_core.provisioning import Provisioning
from switch_core.provisioning.postgres import PostgresProvisioning


@pytest.mark.parametrize("implementation", [MatrixAdmin, PostgresProvisioning])
def test_it_is_a_provisioning_implementation(implementation: type) -> None:
    assert isinstance(implementation.__new__(implementation), Provisioning), (
        f"{implementation.__name__} no longer satisfies Provisioning"
    )


def test_every_port_operation_has_a_matching_signature() -> None:
    """`isinstance` on a Protocol checks names only, not what they take.

    A parameter renamed or dropped on one side is exactly the drift this port
    exists to prevent, and it is invisible to the check above.
    """
    for name in (
        "register_user",
        "verify_login",
        "create_room",
        "invite_to_room",
        "kick_user",
        "delete_room",
        "close",
    ):
        expected = _rendered(getattr(Provisioning, name))
        for implementation in (MatrixAdmin, PostgresProvisioning):
            actual = _rendered(getattr(implementation, name))
            assert actual == expected, (
                f"{implementation.__name__}.{name} does not match the port"
            )


def _rendered(func: object) -> str:
    """A signature as text, with the quotes deferred annotations add removed.

    The port defers its annotations and `matrix_admin` does not, so the two
    render the same types differently — `'str'` against `str` — while meaning
    the same thing. Comparing the text without quotes compares the contract.
    """
    return str(inspect.signature(func)).replace("'", "")
