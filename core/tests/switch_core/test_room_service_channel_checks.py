"""What room creation asks before it gives a room a channel. Real Postgres.

A private channel is made only for a room owner with a confirmed linked
account on its platform, or refused before the platform is asked: on a
platform that needs an owner (Teams) that account is named its owner, and
elsewhere it is put in the channel, so the channel is never left with nobody
able to get in. A channel named by id is refused, with a reason the person can act on,
when another room already uses it or the platform says the room cannot use it,
including when two rooms race to the same channel.

A public channel is made whether or not the owner has a confirmed link, and
the owner is put in it when they have one, except on a platform where joining
a public channel means joining more (Teams).
"""

from __future__ import annotations

from collections.abc import Collection
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.models import (
    ChannelInUse,
    ChannelNotUsable,
    CreatedChannel,
    PrivateChannelOwnerMissing,
)
from switch_core.db.models import (
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    User,
)
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomCreateConfig, RoomService

DIRECTORY_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
CHANNEL_ACCOUNT = "29:1a2b3c-channel-account"


class _Reached(Exception):
    """Raised by the first step after the channel exists, to stop there."""


class _Adapter:
    platform_name = "Teams"

    def __init__(
        self, *, needs_owner: bool, adds_creator_to_public: bool = True
    ) -> None:
        self.private_channel_needs_owner = needs_owner
        self.adds_creator_to_public_channel = adds_creator_to_public
        self.created: list[dict[str, Any]] = []
        self.checked: list[str] = []
        self.not_usable: dict[str, str] = {}

    def can_own_channel(self, external_user_id: str) -> bool:
        return not external_user_id.startswith("29:")

    async def require_bindable_channel(self, channel_id: str) -> None:
        return None

    async def check_channel_usable(self, channel_id: str) -> None:
        self.checked.append(channel_id)
        if channel_id in self.not_usable:
            raise ChannelNotUsable(self.not_usable[channel_id])

    async def get_channel_type(self, channel_id: str) -> str:
        return "channel_public"

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: str = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        self.created.append(
            {"channel_type": channel_type, "owner_external_id": owner_external_id}
        )
        return CreatedChannel(id="19:new@thread.tacv2", name=name)


class _Core:
    def __init__(self, adapter: _Adapter) -> None:
        self.adapter = adapter

    def begin_provisioning(self, external_channel_id: str) -> None:
        return None

    def end_provisioning(self, external_channel_id: str) -> None:
        return None


class _Lifecycle:
    def __init__(self, bridge_id: str, core: _Core) -> None:
        self._bridges = {bridge_id: core}

    def get(self, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)


class _StopAtTransportRoom:
    async def create_room(self, name: str, description: str) -> str:
        raise _Reached


class _Never:
    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"reached: {name}")


def _service(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    adapter: _Adapter,
    provisioning: Any = None,
) -> RoomService:
    never: Any = _Never()
    return RoomService(
        provisioning=provisioning or _StopAtTransportRoom(),
        room_store=RoomStore(),
        agent_store=never,
        client_lifecycle=never,
        collab_lifecycle=_Lifecycle(bridge_id, _Core(adapter)),  # type: ignore[arg-type]
        collab_bridge_store=CollaborationBridgeStore(),
        resource_service=never,
        session_factory=session_factory,
        room_cache=never,
    )


async def _setup(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    linked: list[tuple[str, bool]],
) -> tuple[str, str]:
    """A user, a Teams bridge, and the accounts the user linked on it, each
    `(platform id, confirmed)`. Returns `(user id, bridge id)`."""
    async with session_factory() as session:
        user = User(name="ada", email="ada@example.invalid", role="user")
        session.add(user)
        bridge_client = Client(
            transport_user_id="@bridge:test", display_name="bridge", type="bridge"
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="teams",
            display_name="Teams",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        for index, (external_id, confirmed) in enumerate(linked):
            platform = Client(
                transport_user_id=f"@ada-teams-{index}:test",
                display_name="ada",
                type="user",
            )
            session.add(platform)
            await session.flush()
            account = ExternalUser(
                bridge_id=bridge.id,
                external_user_id=external_id,
                external_username="ada",
                client_id=platform.id,
            )
            session.add(account)
            await session.flush()
            session.add(
                ExternalUserClaim(
                    external_user_id=account.id,
                    user_id=user.id,
                    verified_at=datetime.now(UTC) if confirmed else None,
                )
            )
        await session.commit()
        return user.id, bridge.id


def _private(bridge_id: str, owner_id: str | None) -> RoomCreateConfig:
    return RoomCreateConfig(
        name="Secret",
        description="",
        bridge_id=bridge_id,
        channel_type="channel_private",
        owner_id=owner_id,
        created_by_kind="agent",
    )


# ── Private channels that need an owner ──────────────────────────────────────


async def test_a_private_channel_is_owned_by_the_room_owners_linked_account(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(
        session_factory, linked=[(CHANNEL_ACCOUNT, True), (DIRECTORY_ID, True)]
    )
    adapter = _Adapter(needs_owner=True)

    with pytest.raises(_Reached):
        await _service(session_factory, bridge_id, adapter).create_room(
            _private(bridge_id, user_id)
        )

    assert adapter.created == [
        {"channel_type": "channel_private", "owner_external_id": DIRECTORY_ID}
    ]


async def test_a_private_channel_without_a_linked_account_is_refused_first(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=[])
    adapter = _Adapter(needs_owner=True)

    with pytest.raises(PrivateChannelOwnerMissing, match="Link your Teams account"):
        await _service(session_factory, bridge_id, adapter).create_room(
            _private(bridge_id, user_id)
        )

    assert adapter.created == []


async def test_an_unconfirmed_link_does_not_make_anyone_an_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=[(DIRECTORY_ID, False)])
    adapter = _Adapter(needs_owner=True)

    with pytest.raises(PrivateChannelOwnerMissing):
        await _service(session_factory, bridge_id, adapter).create_room(
            _private(bridge_id, user_id)
        )

    assert adapter.created == []


async def test_a_link_the_platform_cannot_make_an_owner_is_said_so(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=[(CHANNEL_ACCOUNT, True)])
    adapter = _Adapter(needs_owner=True)

    with pytest.raises(PrivateChannelOwnerMissing, match="cannot be made one"):
        await _service(session_factory, bridge_id, adapter).create_room(
            _private(bridge_id, user_id)
        )

    assert adapter.created == []


async def test_a_room_with_no_owner_cannot_have_a_private_channel_there(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, bridge_id = await _setup(session_factory, linked=[(DIRECTORY_ID, True)])
    adapter = _Adapter(needs_owner=True)

    with pytest.raises(PrivateChannelOwnerMissing):
        await _service(session_factory, bridge_id, adapter).create_room(
            _private(bridge_id, None)
        )


def _public(bridge_id: str, owner_id: str | None) -> RoomCreateConfig:
    return _private(bridge_id, owner_id).model_copy(
        update={"channel_type": "channel_public"}
    )


async def test_a_public_channel_needs_no_linked_account(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=[])
    for needs_owner in (False, True):
        adapter = _Adapter(needs_owner=needs_owner)
        config = _private(bridge_id, user_id).model_copy(
            update={"channel_type": "channel_public"}
        )
        with pytest.raises(_Reached):
            await _service(session_factory, bridge_id, adapter).create_room(config)
        assert adapter.created == [
            {"channel_type": "channel_public", "owner_external_id": None}
        ]


# ── Public channels: the room owner is put in them when they can be ─────────


async def test_a_public_channel_is_made_for_the_owners_confirmed_account(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=[(CHANNEL_ACCOUNT, True)])
    adapter = _Adapter(needs_owner=False)
    svc = _service(session_factory, bridge_id, adapter)

    _, creator = await svc._create_channel(
        _Core(adapter),  # type: ignore[arg-type]
        bridge_id,
        "Open",
        "",
        "channel_public",
        owner_user_id=user_id,
    )

    assert adapter.created == [
        {"channel_type": "channel_public", "owner_external_id": None}
    ]
    assert creator is not None
    assert creator.external_user_id == CHANNEL_ACCOUNT


@pytest.mark.parametrize(
    ("linked", "owner"),
    [([], True), ([(DIRECTORY_ID, False)], True), ([(DIRECTORY_ID, True)], False)],
    ids=["no-link", "unconfirmed", "no-owner"],
)
async def test_a_public_channel_is_made_without_someone_to_put_in_it(
    session_factory: async_sessionmaker[AsyncSession],
    linked: list[tuple[str, bool]],
    owner: bool,
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=linked)
    adapter = _Adapter(needs_owner=False)
    svc = _service(session_factory, bridge_id, adapter)

    _, creator = await svc._create_channel(
        _Core(adapter),  # type: ignore[arg-type]
        bridge_id,
        "Open",
        "",
        "channel_public",
        owner_user_id=user_id if owner else None,
    )

    assert adapter.created == [
        {"channel_type": "channel_public", "owner_external_id": None}
    ]
    assert creator is None


async def test_nobody_is_put_in_a_public_channel_where_that_joins_more(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Teams: a standard channel's members are the team's.
    user_id, bridge_id = await _setup(session_factory, linked=[(DIRECTORY_ID, True)])
    adapter = _Adapter(needs_owner=True, adds_creator_to_public=False)
    svc = _service(session_factory, bridge_id, adapter)

    _, creator = await svc._create_channel(
        _Core(adapter),  # type: ignore[arg-type]
        bridge_id,
        "Open",
        "",
        "channel_public",
        owner_user_id=user_id,
    )

    assert creator is None


# ── Private channels elsewhere: the room owner is put in them ────────────────


async def test_a_private_channel_elsewhere_is_made_for_the_owners_account(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # No owner is named where the platform needs none, but the account is
    # handed back for the room to put in the channel once it exists.
    user_id, bridge_id = await _setup(session_factory, linked=[(CHANNEL_ACCOUNT, True)])
    adapter = _Adapter(needs_owner=False)
    svc = _service(session_factory, bridge_id, adapter)

    created, creator = await svc._create_channel(
        _Core(adapter),  # type: ignore[arg-type]
        bridge_id,
        "Secret",
        "",
        "channel_private",
        owner_user_id=user_id,
    )

    assert created.id == "19:new@thread.tacv2"
    assert adapter.created == [
        {"channel_type": "channel_private", "owner_external_id": None}
    ]
    assert creator is not None
    assert creator.external_user_id == CHANNEL_ACCOUNT


@pytest.mark.parametrize(
    "linked", [[], [(DIRECTORY_ID, False)]], ids=["none", "unconfirmed"]
)
async def test_a_private_channel_elsewhere_needs_a_confirmed_link(
    session_factory: async_sessionmaker[AsyncSession],
    linked: list[tuple[str, bool]],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=linked)
    adapter = _Adapter(needs_owner=False)

    with pytest.raises(
        PrivateChannelOwnerMissing,
        match="Only the people added to a private Teams channel can see it",
    ):
        await _service(session_factory, bridge_id, adapter).create_room(
            _private(bridge_id, user_id)
        )

    assert adapter.created == []


async def test_a_room_with_no_owner_gets_no_private_channel_elsewhere(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, bridge_id = await _setup(session_factory, linked=[(DIRECTORY_ID, True)])
    adapter = _Adapter(needs_owner=False)

    with pytest.raises(PrivateChannelOwnerMissing):
        await _service(session_factory, bridge_id, adapter).create_room(
            _private(bridge_id, None)
        )

    assert adapter.created == []


# ── Existing channels ────────────────────────────────────────────────────────


def _existing(bridge_id: str, channel_id: str) -> RoomCreateConfig:
    return RoomCreateConfig(
        name="Reuse",
        description="",
        bridge_id=bridge_id,
        external_channel_id=channel_id,
        # Given, as a caller may: the channel is checked anyway.
        channel_type="channel_public",
        created_by_kind="user",
    )


async def _bind_room(
    session_factory: async_sessionmaker[AsyncSession], bridge_id: str, channel: str
) -> None:
    async with session_factory() as session:
        session.add(
            Room(
                transport_room_id="!taken:test",
                name="taken",
                description="",
                bridge_id=bridge_id,
                external_channel_id=channel,
            )
        )
        await session.commit()


async def test_a_channel_another_room_uses_is_refused_before_anything_is_made(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, bridge_id = await _setup(session_factory, linked=[])
    await _bind_room(session_factory, bridge_id, "C-TAKEN")
    adapter = _Adapter(needs_owner=False)

    with pytest.raises(ChannelInUse, match="already used by a room"):
        await _service(session_factory, bridge_id, adapter).create_room(
            _existing(bridge_id, "C-TAKEN")
        )

    assert adapter.checked == []


async def test_the_platforms_reason_is_given_for_a_channel_it_cannot_use(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, bridge_id = await _setup(session_factory, linked=[])
    adapter = _Adapter(needs_owner=False)
    adapter.not_usable["C-MISSING"] = "Slack cannot find channel C-MISSING."

    with pytest.raises(ChannelNotUsable, match="Slack cannot find channel"):
        await _service(session_factory, bridge_id, adapter).create_room(
            _existing(bridge_id, "C-MISSING")
        )

    assert adapter.checked == ["C-MISSING"]


async def test_two_rooms_racing_to_one_channel_leave_the_loser_a_conflict(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, bridge_id = await _setup(session_factory, linked=[])
    adapter = _Adapter(needs_owner=False)

    class _Provisioning:
        async def create_room(self, name: str, description: str) -> str:
            # The other room binds the channel after this one checked it.
            await _bind_room(session_factory, bridge_id, "C-RACED")
            return "!loser:test"

    svc = _service(session_factory, bridge_id, adapter, _Provisioning())

    with pytest.raises(ChannelInUse):
        await svc.create_room(_existing(bridge_id, "C-RACED"))

    async with session_factory() as session:
        count = await session.scalar(
            select(func.count()).where(Room.external_channel_id == "C-RACED")
        )
    assert count == 1


async def test_losing_a_race_while_binding_an_existing_room_is_a_conflict(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same race on the path that binds a room that already exists, against
    the real unique index: the refusal comes back as `ChannelInUse`, whether
    the database raises it on the write or at commit."""
    _, bridge_id = await _setup(session_factory, linked=[])
    async with session_factory() as session:
        loser = Room(transport_room_id="!loser:test", name="loser", description="")
        session.add(loser)
        await session.commit()
        loser_id = loser.id
    adapter = _Adapter(needs_owner=False)
    svc = _service(session_factory, bridge_id, adapter)

    async def other_room_binds_it_meanwhile(*_: Any, **__: Any) -> None:
        # Passes the check, then loses the channel before writing.
        await _bind_room(session_factory, bridge_id, "C-RACED")

    monkeypatch.setattr(svc, "_require_channel_unused", other_room_binds_it_meanwhile)

    with pytest.raises(ChannelInUse):
        await svc.link_bridge_to_room(
            loser_id, bridge_id, "channel_public", external_channel_id="C-RACED"
        )

    async with session_factory() as session:
        reloaded = await session.get(Room, loser_id)
    assert reloaded is not None and reloaded.external_channel_id is None


# ── The whole creation: who ends up in a new private channel ─────────────────


class _FlowAdapter(_Adapter):
    def __init__(self, *, needs_owner: bool, refuses: Collection[str] = ()) -> None:
        super().__init__(needs_owner=needs_owner)
        self.added: list[list[str]] = []
        self._refuses = set(refuses)

    async def ensure_channel_subscriptions(self, channels: Any) -> None:
        return None

    async def add_agents_to_channel(self, channel_id: str, names: list[str]) -> None:
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        self.added.append(list(user_external_ids))
        return [each for each in user_external_ids if each in self._refuses]


class _FlowCore(_Core):
    _workspace_consumer_transport_user_id = "@bridge:test"

    def __init__(self, adapter: _Adapter, known: dict[str, str]) -> None:
        super().__init__(adapter)
        self._known = known
        self.in_room: list[str] = []

    def add_room_mapping(self, *args: Any) -> None:
        return None

    async def resolve_external_user_id_map(
        self, user_names: list[str]
    ) -> dict[str, str]:
        return {n: self._known[n] for n in user_names if n in self._known}

    async def ensure_users_in_room(
        self, room_id: str, transport_room_id: str, user_names: list[str]
    ) -> None:
        self.in_room.extend(self._known[n] for n in user_names if n in self._known)

    async def ensure_external_users_in_room(
        self, room_id: str, transport_room_id: str, external_user_ids: list[str]
    ) -> None:
        self.in_room.extend(external_user_ids)


class _FlowLifecycle(_Lifecycle):
    def rooms_changed(self, bridge_id: str) -> None:
        return None


class _FlowProvisioning:
    async def create_room(self, name: str, description: str) -> str:
        return "!secret:test"

    async def invite_to_room(self, transport_room_id: str, user_id: str) -> None:
        return None


class _NoClients:
    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


def _flow_service(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    core: _FlowCore,
) -> RoomService:
    svc = _service(session_factory, bridge_id, core.adapter, _FlowProvisioning())  # type: ignore[arg-type]
    svc._collab_lifecycle = _FlowLifecycle(bridge_id, core)  # type: ignore[assignment]
    svc._client_lifecycle = _NoClients()  # type: ignore[assignment]
    return svc


async def test_the_creator_is_put_in_their_new_private_channel_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Named in the request too, as a Console chat names its creator: the
    # platform is asked once, and everyone else is still added.
    user_id, bridge_id = await _setup(session_factory, linked=[(CHANNEL_ACCOUNT, True)])
    adapter = _FlowAdapter(needs_owner=False)
    core = _FlowCore(adapter, known={"ada": CHANNEL_ACCOUNT, "bob": "U-BOB"})
    config = _private(bridge_id, user_id).model_copy(
        update={"user_names": ["ada", "bob"]}
    )

    result = await _flow_service(session_factory, bridge_id, core).create_room(config)

    assert adapter.added == [[CHANNEL_ACCOUNT], ["U-BOB"]]
    assert CHANNEL_ACCOUNT in core.in_room
    assert result.failed_attachments == []


async def test_the_owner_named_on_teams_is_not_added_again(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=[(DIRECTORY_ID, True)])
    adapter = _FlowAdapter(needs_owner=True)
    core = _FlowCore(adapter, known={})

    await _flow_service(session_factory, bridge_id, core).create_room(
        _private(bridge_id, user_id)
    )

    assert adapter.created[0]["owner_external_id"] == DIRECTORY_ID
    assert adapter.added == []
    assert core.in_room == [DIRECTORY_ID]


async def test_the_creator_is_put_in_their_new_public_channel_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=[(CHANNEL_ACCOUNT, True)])
    adapter = _FlowAdapter(needs_owner=False)
    core = _FlowCore(adapter, known={"ada": CHANNEL_ACCOUNT, "bob": "U-BOB"})
    config = _public(bridge_id, user_id).model_copy(
        update={"user_names": ["ada", "bob"]}
    )

    result = await _flow_service(session_factory, bridge_id, core).create_room(config)

    assert adapter.added == [[CHANNEL_ACCOUNT], ["U-BOB"]]
    assert CHANNEL_ACCOUNT in core.in_room
    assert result.failed_attachments == []


async def test_a_public_channel_without_a_link_is_made_with_nobody_added(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=[])
    adapter = _FlowAdapter(needs_owner=False)
    core = _FlowCore(adapter, known={})

    result = await _flow_service(session_factory, bridge_id, core).create_room(
        _public(bridge_id, user_id)
    )

    assert adapter.created == [
        {"channel_type": "channel_public", "owner_external_id": None}
    ]
    assert adapter.added == []
    assert core.in_room == []
    assert result.failed_attachments == []


async def test_a_platform_refusing_the_creator_of_a_public_channel_is_reported(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, bridge_id = await _setup(session_factory, linked=[(CHANNEL_ACCOUNT, True)])
    adapter = _FlowAdapter(needs_owner=False, refuses=[CHANNEL_ACCOUNT])
    core = _FlowCore(adapter, known={})

    result = await _flow_service(session_factory, bridge_id, core).create_room(
        _public(bridge_id, user_id)
    )

    assert result.failed_attachments == [
        {
            "kind": "user",
            "id": "ada",
            "error": "the platform would not add you to the channel",
        }
    ]
