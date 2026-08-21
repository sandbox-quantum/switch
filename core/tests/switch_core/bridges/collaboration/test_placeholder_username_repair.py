"""CHOO-2067 — a person filed under a platform id gets their name back.

Switch records someone under the name it first sees. Teams does not always
supply one — a 1:1 chat activity often carries no `from.name` — so its own id
went in instead, and then read as that person's name everywhere: the title of
the room auto-created for them, their Matrix account, and the text of every
agent reply that addressed them.

Resolving the name properly stopped it happening to the next person and did
nothing for anyone already recorded, which is most of the people in a
deployment that has been running. This repairs them on their next message.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

_TEAMS_ID = "29:1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"


class _FakeSession:
    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def commit(self) -> None:
        return None


class _Store:
    def __init__(self, user: Any) -> None:
        self._user = user
        self.renames: list[tuple[str, str]] = []

    async def get_by_external_id(
        self, session: Any, bridge_id: str, external_user_id: str
    ) -> Any:
        return self._user

    async def rename(self, session: Any, user_id: str, external_username: str) -> None:
        self.renames.append((user_id, external_username))
        self._user.external_username = external_username


class _Puppet:
    def __init__(self) -> None:
        self.names: list[str] = []

    async def set_display_name(self, name: str) -> None:
        self.names.append(name)


class _Lifecycle:
    def __init__(self, puppet: Any) -> None:
        self._puppet = puppet

    def get(self, client_id: str) -> Any:
        return self._puppet


def _teams_adapter() -> TeamsAdapter:
    return TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-9",
            team_id="team-7",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )


def _core(stored_name: str, *, adapter: Any = None, puppet: Any = None) -> Any:
    user = SimpleNamespace(
        id="eu-1", external_username=stored_name, client_id="client-1"
    )
    core = object.__new__(BridgeCore)
    core._session_factory = lambda: _FakeSession()  # type: ignore[attr-defined]
    core._bridge_id = "bridge-1"  # type: ignore[attr-defined]
    core._bridge_type = "teams"  # type: ignore[attr-defined]
    core._adapter = adapter or _teams_adapter()  # type: ignore[attr-defined]
    core._external_user_store = _Store(user)  # type: ignore[attr-defined]
    core._client_lifecycle = _Lifecycle(puppet or _Puppet())  # type: ignore[attr-defined]
    return core


# ── recognising an id ────────────────────────────────────────────────────────


def test_teams_recognises_its_own_ids() -> None:
    adapter = _teams_adapter()

    assert adapter.is_placeholder_username(_TEAMS_ID)
    assert adapter.is_placeholder_username("8:orgid:abc-def")
    assert adapter.is_placeholder_username("50758b1a-9d9a-4430-8160-1a2b3c4d5e6f")


def test_teams_does_not_mistake_a_name_for_an_id() -> None:
    adapter = _teams_adapter()

    for name in ("ada.lovelace", "Ada Lovelace", "alice", "a1b2c3"):
        assert not adapter.is_placeholder_username(name), name


def test_a_platform_whose_handles_are_handles_recognises_nothing() -> None:
    # The default: nothing to recognise, so nothing is ever renamed.
    from switch_core.bridges.collaboration.adapter import CollaborationAdapter

    assert CollaborationAdapter.is_placeholder_username(None, _TEAMS_ID) is False  # type: ignore[arg-type]


# ── the repair ───────────────────────────────────────────────────────────────


async def test_an_id_is_replaced_by_the_name_and_the_account_renamed() -> None:
    puppet = _Puppet()
    core = _core(_TEAMS_ID, puppet=puppet)

    await core._repair_placeholder_username("aad-1", "ada.lovelace")

    assert core._external_user_store.renames == [("eu-1", "ada.lovelace")]
    assert puppet.names == ["ada.lovelace"]


async def test_a_real_name_already_stored_is_left_alone() -> None:
    # Renaming someone people have been addressing for weeks, because the
    # platform changed its mind about their display name, is worse than the
    # problem being fixed.
    core = _core("ada.lovelace")

    await core._repair_placeholder_username("aad-1", "Ada L")

    assert core._external_user_store.renames == []


async def test_an_id_is_never_written_over_a_name() -> None:
    # The resolution can still fail and fall back to the id. That must not
    # undo a good name.
    core = _core("ada.lovelace")

    await core._repair_placeholder_username("aad-1", _TEAMS_ID)

    assert core._external_user_store.renames == []


async def test_one_id_is_not_swapped_for_another() -> None:
    core = _core(_TEAMS_ID)

    await core._repair_placeholder_username("aad-1", "8:orgid:something")

    assert core._external_user_store.renames == []


async def test_nothing_happens_when_the_name_is_unchanged() -> None:
    core = _core(_TEAMS_ID)

    await core._repair_placeholder_username("aad-1", _TEAMS_ID)

    assert core._external_user_store.renames == []


async def test_an_empty_resolution_is_ignored() -> None:
    core = _core(_TEAMS_ID)

    await core._repair_placeholder_username("aad-1", "")

    assert core._external_user_store.renames == []


async def test_the_rename_stands_even_if_the_account_cannot_be_relabelled() -> None:
    # The stored name is what agents address; the Matrix label is cosmetic.
    # Losing the second is no reason to abandon the first.
    class _Failing(_Puppet):
        async def set_display_name(self, name: str) -> None:
            raise RuntimeError("homeserver said no")

    core = _core(_TEAMS_ID, puppet=_Failing())

    await core._repair_placeholder_username("aad-1", "ada.lovelace")

    assert core._external_user_store.renames == [("eu-1", "ada.lovelace")]
