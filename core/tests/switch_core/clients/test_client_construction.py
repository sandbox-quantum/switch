"""Every client subclass must be constructible through the real signature.

Three subclasses take `**kwargs: Any` and forward to `ClientBase`, which
hides the constructor from the type checker: a keyword `ClientBase` no
longer accepts type-checks clean and fails at runtime, when the client
starts. That is how a `device_id` left behind by the transport port took
down all four collaboration bridges while mypy stayed green.

These tests call the constructors the way production does.
"""

from __future__ import annotations

import ast
import inspect
import pathlib
from typing import Any

import pytest

from switch_core.clients.admin_client import AdminClient
from switch_core.clients.bridge_client import BridgeClient, BridgeClientConfig
from switch_core.clients.client_base import ClientBase, ClientConfig
from switch_core.clients.client_factory import matrix_transport_for
from switch_core.clients.user_client import UserClient
from tests.switch_core.transport.fake import FakeMessageRecorder


def _base_kwargs() -> dict[str, Any]:
    return {
        "client_id": "client-1",
        "matrix_user_id": "@switch-agent-1:switch.local",
        "display_name": "agent-one",
        "password": "pw",
        "server_url": "https://matrix.example",
        "session_factory": object(),
        "client_store": object(),
        "transport_factory": matrix_transport_for,
        "session_state": {"access_token": None, "device_id": None},
        "next_batch_token": None,
        "message_recorder": FakeMessageRecorder(),
    }


def test_client_base_takes_what_the_factory_passes() -> None:
    client = ClientBase(config=ClientConfig(), **_base_kwargs())

    assert client.client_id == "client-1"
    # Credentials are held opaquely, not unpacked into named attributes.
    assert client.session_state == {"access_token": None, "device_id": None}


def test_bridge_client_construction_matches_its_lifecycle_call_site() -> None:
    client = BridgeClient(
        bridge_core=object(),  # type: ignore[arg-type]
        config=BridgeClientConfig(bridge_id="bridge-1"),
        **_base_kwargs(),
    )

    assert client.config.bridge_id == "bridge-1"


@pytest.mark.parametrize("cls", [UserClient, AdminClient])
def test_every_registered_client_type_constructs(cls: type) -> None:
    base = _base_kwargs()
    # Collaborators the factory injects as extra kwargs differ per class, so
    # stub whatever each one declares rather than naming them here.
    collaborators: dict[str, Any] = {}
    for name, param in inspect.signature(cls.__init__).parameters.items():
        if (
            param.kind is not inspect.Parameter.KEYWORD_ONLY
            or param.default is not inspect.Parameter.empty
            or name in base
            or name == "config"
        ):
            continue
        # A plain object() stands in for a collaborator, but a few are strings
        # the constructor manipulates on the way in.
        collaborators[name] = "" if "str" in str(param.annotation) else object()

    client = cls(config=cls.config_class(), **base, **collaborators)

    assert isinstance(client, ClientBase)


def test_no_client_holds_matrix_credentials_directly() -> None:
    """The transport owns them; a client that reads them is a Matrix client."""
    client = ClientBase(config=ClientConfig(), **_base_kwargs())

    assert not hasattr(client, "access_token")
    assert not hasattr(client, "device_id")


def test_no_call_site_passes_transport_credentials_to_a_client() -> None:
    """Catch the caller, which the constructor tests above cannot.

    `**kwargs: Any` means a call site passing `device_id=` type-checks and
    then fails when the client starts. Constructing a client correctly in a
    test proves nothing about the places that construct it wrongly, so scan
    for the argument itself.
    """
    package = pathlib.Path(__file__).resolve().parents[3] / "switch_core"
    retired = {"device_id", "access_token"}
    offenders: list[str] = []

    for path in package.rglob("*.py"):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = getattr(func, "id", None) or getattr(func, "attr", "")
            if not name.endswith("Client"):
                continue
            passed = {kw.arg for kw in node.keywords if kw.arg}
            for arg in sorted(passed & retired):
                offenders.append(f"{path.relative_to(package)}: {name}({arg}=...)")

    assert offenders == [], (
        "clients take an opaque `session_state`, not individual credentials; "
        f"these call sites still pass them: {offenders}"
    )


def test_only_the_factory_names_a_transport_implementation() -> None:
    """A client's bus is one decision, made in one place.

    The collaboration bridges named `matrix_transport_for` directly, so the
    transport setting reached every agent and no bridge: agents talked in rows,
    bridges talked to the homeserver, and neither side saw the other or logged
    anything. Nothing failed — messages simply stopped crossing.

    That is invisible in review, so scan for the cause instead. Any module that
    can name an implementation can pick the wrong one.
    """
    package = pathlib.Path(__file__).resolve().parents[3] / "switch_core"
    implementations = {"matrix_transport_for", "MatrixTransport", "PostgresTransport"}
    allowed = {
        "clients/client_factory.py",
        "transport/matrix.py",
        "transport/postgres.py",
    }
    offenders: list[str] = []

    for path in package.rglob("*.py"):
        relative = path.relative_to(package).as_posix()
        if relative in allowed:
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom):
                continue
            for alias in node.names:
                if alias.name in implementations:
                    offenders.append(f"{relative}: {alias.name}")

    assert offenders == [], (
        "ask ClientFactory.transport_for for a transport rather than naming "
        f"one; these modules choose for themselves: {offenders}"
    )
