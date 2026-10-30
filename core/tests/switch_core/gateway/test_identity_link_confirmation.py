"""A link from a chat account to a Switch user waits for the account to confirm
it (CHOO-3881).

Against real Postgres and real stores, calling the route handlers directly:
what matters is which rows a request leaves behind, since a claim row is what
every owner check trusts.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    TenantMember,
    User,
)
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth_routes import my_identities, my_pending_identities
from switch_core.gateway.collaborations import (
    cancel_identity_link_request,
    claim_bridge_identity,
    issue_identity_link_code,
    list_unconfirmed_identity_links,
    release_bridge_identity,
    require_identity_confirmation,
    verify_identity_with_session,
)
from switch_core.gateway.schemas import (
    ClaimIdentityRequest,
    VerifyIdentitySessionRequest,
)

_STORE = ExternalUserStore()
_STAND_IN = "stand-in"


class _Adapter:
    def __init__(
        self,
        session_owner: str | Exception,
        meanwhile: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._session_owner = session_owner
        self._meanwhile = meanwhile

    async def account_id_for_session(self, _token: str) -> str:
        if self._meanwhile is not None:
            await self._meanwhile()
        if isinstance(self._session_owner, Exception):
            raise self._session_owner
        return self._session_owner


class _Lifecycle:
    def __init__(self, adapter: _Adapter | None = None) -> None:
        self._adapter = adapter

    def unlinkable_account_reason(
        self, _bridge_type: str, external_user_id: str
    ) -> str | None:
        return "Many people post as it." if external_user_id == _STAND_IN else None

    def link_code_instructions(
        self, bridge_type: str, _connection_config: object, code: str
    ) -> str:
        return f"On {bridge_type}, post `!link-account {code}`."

    def get_adapter(self, _bridge_id: str) -> _Adapter | None:
        return self._adapter


class _World:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        bridge_id: str,
        account: ExternalUser,
        ada: User,
        bob: User,
    ) -> None:
        self.session_factory = session_factory
        self.bridge_id = bridge_id
        self.account = account
        self.ada = ada
        self.bob = bob


async def _client(session: AsyncSession, client_type: str) -> str:
    client = Client(
        transport_user_id=f"@{client_type}-{uuid.uuid4().hex[:8]}:test",
        display_name=client_type,
        type=client_type,
    )
    session.add(client)
    await session.flush()
    return client.id


async def _member(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}-{uuid.uuid4().hex[:6]}@test", role="user")
    session.add(user)
    await session.flush()
    session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member"))
    await session.flush()
    return user


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> _World:
    async with session_factory() as session:
        bridge = CollaborationBridge(
            type="slack",
            display_name="Acme Slack",
            client_id=await _client(session, "bridge"),
            status="active",
        )
        session.add(bridge)
        await session.flush()
        account = ExternalUser(
            bridge_id=bridge.id,
            external_user_id="U-ada",
            external_username="ada",
            client_id=await _client(session, "external_user"),
        )
        session.add(account)
        for stand_in in (_STAND_IN,):
            session.add(
                ExternalUser(
                    bridge_id=bridge.id,
                    external_user_id=stand_in,
                    external_username="Group",
                    client_id=await _client(session, "external_user"),
                )
            )
        ada = await _member(session, "ada")
        bob = await _member(session, "bob")
        await session.commit()
        return _World(session_factory, bridge.id, account, ada, bob)


async def _claim(
    world: _World,
    caller: User,
    *,
    external_user_id: str = "U-ada",
    for_user: User | None = None,
    is_admin: bool = False,
    expects_confirmation: bool = True,
) -> object:
    async with world.session_factory() as session:
        return await claim_bridge_identity(
            world.bridge_id,
            ClaimIdentityRequest(
                external_user_id=external_user_id,
                username="ada",
                user_id=for_user.id if for_user is not None else None,
                expects_confirmation=expects_confirmation,
            ),
            session,
            CollaborationBridgeStore(),
            _STORE,
            UserStore(),
            _Lifecycle(),  # type: ignore[arg-type]
            caller,
            is_admin,
        )


async def _issue(world: _World, caller: User) -> object:
    async with world.session_factory() as session:
        return await issue_identity_link_code(
            world.bridge_id,
            world.account.id,
            session,
            CollaborationBridgeStore(),
            _STORE,
            _Lifecycle(),  # type: ignore[arg-type]
            caller,
        )


async def _verify(world: _World, caller: User, adapter: _Adapter | None) -> object:
    async with world.session_factory() as session:
        return await verify_identity_with_session(
            world.bridge_id,
            world.account.id,
            VerifyIdentitySessionRequest(token="session-token"),
            session,
            _STORE,
            UserStore(),
            _Lifecycle(adapter),  # type: ignore[arg-type]
            caller,
        )


async def _claim_of(world: _World, user: User) -> ExternalUserClaim | None:
    async with world.session_factory() as session:
        return await _STORE.get_claim(session, world.account.id, user.id)


class TestClaimWaitsForTheAccount:
    async def test_a_claim_for_yourself_comes_back_with_a_code(
        self, world: _World
    ) -> None:
        summary = await _claim(world, world.ada)

        request = summary.link_request  # type: ignore[attr-defined]
        assert request is not None
        assert request.user_id == world.ada.id
        assert request.code is not None
        assert request.code.instructions == (
            f"On slack, post `!link-account {request.code.code}`."
        )
        assert isinstance(request.code.expires_at, datetime)
        assert request.code.expires_in_seconds == 1800
        assert summary.claimed_by == []  # type: ignore[attr-defined]
        assert await _claim_of(world, world.ada) is None

    async def test_an_account_already_confirmed_needs_nothing(
        self, world: _World
    ) -> None:
        summary = await _claim(world, world.ada)
        code = summary.link_request.code.code  # type: ignore[attr-defined]
        async with world.session_factory() as session:
            assert await _STORE.redeem_link_code(session, world.account, code)
            await session.commit()

        again = await _claim(world, world.ada)

        assert again.link_request is None  # type: ignore[attr-defined]
        assert [
            (c.user_id, c.verified)
            for c in again.claimed_by  # type: ignore[attr-defined]
        ] == [(world.ada.id, True)]

    async def test_a_console_from_before_confirmation_is_told_to_update(
        self, world: _World
    ) -> None:
        # It would otherwise drop the code and report a link that counts for
        # nothing as made.
        with pytest.raises(HTTPException) as refused:
            await _claim(world, world.ada, expects_confirmation=False)

        assert refused.value.status_code == 409
        assert "Update Switch Console" in refused.value.detail
        async with world.session_factory() as session:
            assert (
                await _STORE.get_link_request(session, world.account.id, world.ada.id)
                is None
            )

    async def test_a_stand_in_account_cannot_be_linked(self, world: _World) -> None:
        with pytest.raises(HTTPException) as refused:
            await _claim(world, world.ada, external_user_id=_STAND_IN)

        assert refused.value.status_code == 409
        assert "Many people post as it." in refused.value.detail


class TestIssuingACode:
    async def test_a_new_code_for_a_waiting_link(self, world: _World) -> None:
        first = await _claim(world, world.ada)

        code = await _issue(world, world.ada)

        assert code.code != first.link_request.code.code  # type: ignore[attr-defined]
        async with world.session_factory() as session:
            assert (
                await _STORE.redeem_link_code(
                    session,
                    world.account,
                    first.link_request.code.code,  # type: ignore[attr-defined]
                )
                is None
            )
            assert await _STORE.redeem_link_code(
                session,
                world.account,
                code.code,  # type: ignore[attr-defined]
            )

    async def test_the_person_an_admin_linked_gets_the_code(
        self, world: _World
    ) -> None:
        await _claim(world, world.bob, for_user=world.ada, is_admin=True)

        code = await _issue(world, world.ada)

        async with world.session_factory() as session:
            confirmed = await _STORE.redeem_link_code(
                session,
                world.account,
                code.code,  # type: ignore[attr-defined]
            )
            assert confirmed is not None
            assert confirmed.user_id == world.ada.id

    async def test_nobody_gets_a_code_for_someone_elses_link(
        self, world: _World
    ) -> None:
        await _claim(world, world.ada)

        with pytest.raises(HTTPException) as refused:
            await _issue(world, world.bob)

        assert refused.value.status_code == 404

    async def test_a_link_from_before_confirmation_can_be_confirmed(
        self, world: _World
    ) -> None:
        async with world.session_factory() as session:
            session.add(
                ExternalUserClaim(
                    external_user_id=world.account.id, user_id=world.ada.id
                )
            )
            await session.commit()

        code = await _issue(world, world.ada)

        # Still trusted meanwhile, and verified once the code is posted.
        claim = await _claim_of(world, world.ada)
        assert claim is not None and claim.verified_at is None
        async with world.session_factory() as session:
            assert await _STORE.redeem_link_code(
                session,
                world.account,
                code.code,  # type: ignore[attr-defined]
            )
            await session.commit()
        claim = await _claim_of(world, world.ada)
        assert claim is not None and claim.verified_at is not None

    async def test_a_code_for_someone_since_removed_confirms_nothing(
        self, world: _World
    ) -> None:
        summary = await _claim(world, world.ada)
        async with world.session_factory() as session:
            await session.delete(
                await session.get(TenantMember, (TENANT_ZERO_ID, world.ada.id))
            )
            await session.commit()

        async with world.session_factory() as session:
            assert (
                await _STORE.redeem_link_code(
                    session,
                    world.account,
                    summary.link_request.code.code,  # type: ignore[attr-defined]
                )
                is None
            )
        assert await _claim_of(world, world.ada) is None

    async def test_a_confirmed_link_needs_no_code(self, world: _World) -> None:
        summary = await _claim(world, world.ada)
        async with world.session_factory() as session:
            assert await _STORE.redeem_link_code(
                session,
                world.account,
                summary.link_request.code.code,  # type: ignore[attr-defined]
            )
            await session.commit()

        with pytest.raises(HTTPException) as refused:
            await _issue(world, world.ada)

        assert refused.value.status_code == 409


class TestVerifyingWithASession:
    async def test_the_accounts_own_session_confirms_the_link(
        self, world: _World
    ) -> None:
        await _claim(world, world.ada)

        summary = await _verify(world, world.ada, _Adapter("U-ada"))

        assert [
            (c.user_id, c.verified)
            for c in summary.claimed_by  # type: ignore[attr-defined]
        ] == [(world.ada.id, True)]

    async def test_another_accounts_session_confirms_nothing(
        self, world: _World
    ) -> None:
        await _claim(world, world.ada)

        with pytest.raises(HTTPException) as refused:
            await _verify(world, world.ada, _Adapter("U-someone-else"))

        assert refused.value.status_code == 403
        assert await _claim_of(world, world.ada) is None

    async def test_a_rejected_session_confirms_nothing(self, world: _World) -> None:
        await _claim(world, world.ada)

        with pytest.raises(HTTPException) as refused:
            await _verify(world, world.ada, _Adapter(PermissionError("not accepted")))

        assert refused.value.status_code == 403
        assert await _claim_of(world, world.ada) is None

    async def test_a_platform_without_session_checks_says_so(
        self, world: _World
    ) -> None:
        await _claim(world, world.ada)

        with pytest.raises(HTTPException) as refused:
            await _verify(world, world.ada, _Adapter(NotImplementedError("no")))

        assert refused.value.status_code == 501

    async def test_a_link_cancelled_during_the_check_is_not_confirmed(
        self, world: _World
    ) -> None:
        await _claim(world, world.ada)

        async def cancel() -> None:
            async with world.session_factory() as session:
                await _STORE.release(session, world.account, world.ada.id)
                await session.commit()

        with pytest.raises(HTTPException) as refused:
            await _verify(world, world.ada, _Adapter("U-ada", meanwhile=cancel))

        assert refused.value.status_code == 409
        assert await _claim_of(world, world.ada) is None

    async def test_there_must_be_a_link_waiting(self, world: _World) -> None:
        with pytest.raises(HTTPException) as refused:
            await _verify(world, world.ada, _Adapter("U-ada"))

        assert refused.value.status_code == 404
        assert await _claim_of(world, world.ada) is None


class TestCancelling:
    async def test_unlinking_cancels_a_waiting_link(self, world: _World) -> None:
        summary = await _claim(world, world.ada)

        async with world.session_factory() as session:
            await release_bridge_identity(
                world.bridge_id,
                world.account.id,
                session,
                _STORE,
                UserStore(),
                world.ada,
                False,
            )

        async with world.session_factory() as session:
            assert (
                await _STORE.get_link_request(session, world.account.id, world.ada.id)
                is None
            )
            assert (
                await _STORE.redeem_link_code(
                    session,
                    world.account,
                    summary.link_request.code.code,  # type: ignore[attr-defined]
                )
                is None
            )

    async def test_cancelling_a_confirmation_keeps_an_older_link(
        self, world: _World
    ) -> None:
        async with world.session_factory() as session:
            session.add(
                ExternalUserClaim(
                    external_user_id=world.account.id, user_id=world.ada.id
                )
            )
            await session.commit()
        code = await _issue(world, world.ada)

        async with world.session_factory() as session:
            await cancel_identity_link_request(
                world.bridge_id,
                world.account.id,
                session,
                _STORE,
                UserStore(),
                world.ada,
                False,
            )

        claim = await _claim_of(world, world.ada)
        assert claim is not None and claim.verified_at is None
        async with world.session_factory() as session:
            assert (
                await _STORE.redeem_link_code(
                    session,
                    world.account,
                    code.code,  # type: ignore[attr-defined]
                )
                is None
            )

    async def test_cancelling_with_nothing_waiting_is_a_404(
        self, world: _World
    ) -> None:
        async with world.session_factory() as session:
            with pytest.raises(HTTPException) as refused:
                await cancel_identity_link_request(
                    world.bridge_id,
                    world.account.id,
                    session,
                    _STORE,
                    UserStore(),
                    world.ada,
                    False,
                )
        assert refused.value.status_code == 404

    async def test_cancelling_someone_elses_takes_an_admin(self, world: _World) -> None:
        await _claim(world, world.ada)

        async with world.session_factory() as session:
            with pytest.raises(HTTPException) as refused:
                await cancel_identity_link_request(
                    world.bridge_id,
                    world.account.id,
                    session,
                    _STORE,
                    UserStore(),
                    world.bob,
                    False,
                    user_id=world.ada.id,
                )
        assert refused.value.status_code == 403

    async def test_unlinking_a_link_that_never_counted_is_audited_as_a_cancel(
        self, world: _World
    ) -> None:
        await _claim(world, world.ada)

        async with world.session_factory() as session:
            await release_bridge_identity(
                world.bridge_id,
                world.account.id,
                session,
                _STORE,
                UserStore(),
                world.ada,
                False,
            )

        async with world.session_factory() as session:
            actions = list(
                await session.scalars(
                    select(AuditEvent.action).where(
                        AuditEvent.target_id == world.account.id
                    )
                )
            )
        assert AuditAction.BRIDGE_IDENTITY_LINK_CANCELLED in actions
        assert AuditAction.BRIDGE_IDENTITY_RELEASED not in actions

    async def test_unlinking_nothing_is_a_404(self, world: _World) -> None:
        async with world.session_factory() as session:
            with pytest.raises(HTTPException) as refused:
                await release_bridge_identity(
                    world.bridge_id,
                    world.account.id,
                    session,
                    _STORE,
                    UserStore(),
                    world.ada,
                    False,
                )
        assert refused.value.status_code == 404


class TestListingYourLinks:
    async def test_a_waiting_link_is_listed_apart_from_the_ones_that_count(
        self, world: _World
    ) -> None:
        await _claim(world, world.bob, for_user=world.ada, is_admin=True)

        async with world.session_factory() as session:
            linked = await my_identities(
                session, _STORE, CollaborationBridgeStore(), world.ada
            )
            pending = await my_pending_identities(
                session, _STORE, CollaborationBridgeStore(), UserStore(), world.ada
            )

        assert linked == []
        assert [
            (p.id, p.bridge_display_name, p.requested_by_name, p.code_expires_at)
            for p in pending
        ] == [(world.account.id, "Acme Slack", "bob", None)]

    async def test_a_link_says_whether_it_was_confirmed(self, world: _World) -> None:
        async with world.session_factory() as session:
            session.add(
                ExternalUserClaim(
                    external_user_id=world.account.id, user_id=world.ada.id
                )
            )
            await session.commit()

        async with world.session_factory() as session:
            linked = await my_identities(
                session, _STORE, CollaborationBridgeStore(), world.ada
            )
            pending = await my_pending_identities(
                session, _STORE, CollaborationBridgeStore(), UserStore(), world.ada
            )

        assert [(i.id, i.verified) for i in linked] == [(world.account.id, False)]
        assert pending == []

    async def test_confirming_an_old_link_does_not_list_it_as_waiting(
        self, world: _World
    ) -> None:
        async with world.session_factory() as session:
            session.add(
                ExternalUserClaim(
                    external_user_id=world.account.id, user_id=world.ada.id
                )
            )
            await session.commit()
        await _issue(world, world.ada)

        async with world.session_factory() as session:
            pending = await my_pending_identities(
                session, _STORE, CollaborationBridgeStore(), UserStore(), world.ada
            )

        assert pending == []


class TestRequiringConfirmationForOlderLinks:
    """An admin can stop trusting the links made before links needed
    confirming, until each owner confirms theirs."""

    async def _older_link(self, world: _World, user: User) -> None:
        async with world.session_factory() as session:
            session.add(
                ExternalUserClaim(external_user_id=world.account.id, user_id=user.id)
            )
            await session.commit()

    async def _list(self, world: _World) -> list[object]:
        async with world.session_factory() as session:
            return list(
                await list_unconfirmed_identity_links(
                    world.bridge_id,
                    session,
                    CollaborationBridgeStore(),
                    _STORE,
                    UserStore(),
                    world.bob,
                )
            )

    async def _require(self, world: _World) -> int:
        async with world.session_factory() as session:
            result = await require_identity_confirmation(
                world.bridge_id,
                session,
                CollaborationBridgeStore(),
                _STORE,
                world.bob,
            )
        return result.moved

    async def test_the_older_links_are_listed(self, world: _World) -> None:
        await self._older_link(world, world.ada)

        [link] = await self._list(world)

        assert (link.id, link.user_id, link.user_name, link.external_username) == (  # type: ignore[attr-defined]
            world.account.id,
            world.ada.id,
            "ada",
            "ada",
        )

    async def test_an_older_link_stops_counting_until_its_owner_confirms_it(
        self, world: _World
    ) -> None:
        await self._older_link(world, world.ada)

        assert await self._require(world) == 1

        assert await _claim_of(world, world.ada) is None
        async with world.session_factory() as session:
            assert await _STORE.claimant_ids(session, world.account.id) == []
            pending = await my_pending_identities(
                session, _STORE, CollaborationBridgeStore(), UserStore(), world.ada
            )
        assert [(p.id, p.requested_by_name) for p in pending] == [
            (world.account.id, "bob")
        ]
        # Confirmed the usual way, it counts again, now verified.
        code = await _issue(world, world.ada)
        async with world.session_factory() as session:
            assert await _STORE.redeem_link_code(
                session,
                world.account,
                code.code,  # type: ignore[attr-defined]
            )
            await session.commit()
        claim = await _claim_of(world, world.ada)
        assert claim is not None and claim.verified_at is not None

    async def test_a_confirmed_link_is_untouched(self, world: _World) -> None:
        summary = await _claim(world, world.ada)
        async with world.session_factory() as session:
            assert await _STORE.redeem_link_code(
                session,
                world.account,
                summary.link_request.code.code,  # type: ignore[attr-defined]
            )
            await session.commit()

        assert await self._require(world) == 0
        assert await self._list(world) == []
        claim = await _claim_of(world, world.ada)
        assert claim is not None and claim.verified_at is not None

    async def test_a_code_already_on_its_way_still_works(self, world: _World) -> None:
        await self._older_link(world, world.ada)
        code = await _issue(world, world.ada)

        assert await self._require(world) == 1

        async with world.session_factory() as session:
            assert await _STORE.redeem_link_code(
                session,
                world.account,
                code.code,  # type: ignore[attr-defined]
            )

    async def test_running_it_again_moves_nothing(self, world: _World) -> None:
        await self._older_link(world, world.ada)

        assert await self._require(world) == 1
        assert await self._require(world) == 0

    async def test_another_bridges_older_links_are_untouched(
        self, world: _World
    ) -> None:
        async with world.session_factory() as session:
            other = CollaborationBridge(
                type="slack",
                display_name="Other Slack",
                client_id=await _client(session, "bridge"),
                status="active",
            )
            session.add(other)
            await session.flush()
            elsewhere = ExternalUser(
                bridge_id=other.id,
                external_user_id="U-ada-elsewhere",
                external_username="ada",
                client_id=await _client(session, "external_user"),
            )
            session.add(elsewhere)
            await session.flush()
            session.add(
                ExternalUserClaim(external_user_id=elsewhere.id, user_id=world.ada.id)
            )
            await session.commit()

        assert await self._require(world) == 0

        async with world.session_factory() as session:
            assert await _STORE.claimant_ids(session, elsewhere.id) == [world.ada.id]

    async def test_it_is_audited(self, world: _World) -> None:
        await self._older_link(world, world.ada)

        await self._require(world)

        async with world.session_factory() as session:
            event = await session.scalar(
                select(AuditEvent).where(
                    AuditEvent.action
                    == AuditAction.BRIDGE_IDENTITY_CONFIRMATION_REQUIRED
                )
            )
        assert event is not None
        assert event.actor_user_id == world.bob.id
        assert event.details == {"moved": 1}
