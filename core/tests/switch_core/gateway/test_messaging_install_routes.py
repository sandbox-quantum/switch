"""Who may do what with an installed messaging app.

An OAuth install creates a connection, which is the deployment operator's, and
every route keeps exactly the operator check it had. A claim-based platform
(Telegram) is different in one respect: one chat is a room, not a connection.
So an admin connects the first chat — which turns the platform on for the
organisation — and after that members connect and disconnect chats, while
removing all of them is an admin's again.

The routes are called directly with a fake service: the rules here are about
the caller, and the service's own behaviour is tested against Postgres
elsewhere.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from switch_core.bridges.collaboration.install import MessagingInstallError
from switch_core.bridges.collaboration.install_service import ClaimLink
from switch_core.db.models import User
from switch_core.gateway.messaging_installs import (
    begin_claim,
    begin_install,
    disconnect_install,
    disconnect_platform,
    installable_platforms,
    list_installs,
)
from switch_core.tenant_context import tenant_scope

_TENANT = "00000000-0000-0000-0000-00000000000a"


def _install(install_id: str, platform: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=install_id,
        platform=platform,
        external_workspace_id=f"ws-{install_id}",
        status="active",
        scopes="",
        bridge_id="b1",
        installed_at="2026-09-28T00:00:00Z",
        ended_at=None,
    )


@dataclass
class _Service:
    connected: bool = False
    not_ready: bool = False
    installs: list[SimpleNamespace] = field(
        default_factory=lambda: [_install("s1", "slack"), _install("t1", "telegram")]
    )
    disconnected: list[str] = field(default_factory=list)
    platforms_disconnected: list[str] = field(default_factory=list)

    def platforms(self) -> list[str]:
        return ["slack", "telegram"]

    def installer(self, platform: str) -> Any:
        if platform not in self.platforms():
            raise MessagingInstallError(f"no {platform} app")
        return SimpleNamespace(installs_by_claim=platform == "telegram")

    async def platform_connected(self, session: Any, *, platform: str) -> bool:
        return self.connected

    async def begin_claim(
        self, session: Any, *, platform: str, user_id: str
    ) -> ClaimLink:
        if self.not_ready:
            raise MessagingInstallError("the bot has not connected yet")
        return ClaimLink(
            url="https://t.me/switch_app_bot?startgroup=c1code",
            code="c1code",
            bot_handle="@switch_app_bot",
        )

    async def begin(self, session: Any, *, platform: str, user_id: str) -> str:
        return f"https://{platform}.example/authorize"

    async def list_installs(self, session: Any) -> list[SimpleNamespace]:
        return self.installs

    async def install_names(self, session: Any) -> dict[str, str]:
        return {"t1": "Telegram: news"}

    async def install_platform(self, session: Any, *, install_id: str) -> str:
        return next(i.platform for i in self.installs if i.id == install_id)

    async def disconnect(self, *, tenant_id: str, install_id: str) -> SimpleNamespace:
        self.disconnected.append(install_id)
        return next(i for i in self.installs if i.id == install_id)

    async def disconnect_platform(
        self, *, tenant_id: str, platform: str
    ) -> list[SimpleNamespace]:
        self.platforms_disconnected.append(platform)
        return [i for i in self.installs if i.platform == platform]


class _Session:
    async def commit(self) -> None:
        return None


def _user(role: str = "user") -> User:
    return User(id=f"u-{role}", name=role, email=f"{role}@example.test", role=role)


class TestWhatIsOffered:
    async def test_a_tenant_admin_sees_oauth_platforms_and_claimable_ones(self) -> None:
        offered = await installable_platforms(
            _Session(),
            _Service(connected=False),
            True,  # type: ignore[arg-type]
        )
        assert offered.platforms == ["slack"]
        (telegram,) = offered.claimable
        assert telegram.can_add_chat and not telegram.can_disconnect_all

    async def test_a_member_is_offered_no_oauth_install(self) -> None:
        offered = await installable_platforms(
            _Session(),
            _Service(connected=True),
            False,  # type: ignore[arg-type]
        )
        assert offered.platforms == []

    async def test_a_member_may_add_a_chat_once_it_is_connected(self) -> None:
        offered = await installable_platforms(
            _Session(),
            _Service(connected=True),
            False,  # type: ignore[arg-type]
        )
        (telegram,) = offered.claimable
        assert telegram.can_add_chat
        assert not telegram.can_disconnect_all

    async def test_a_member_may_not_turn_it_on(self) -> None:
        offered = await installable_platforms(
            _Session(),
            _Service(connected=False),
            False,  # type: ignore[arg-type]
        )
        (telegram,) = offered.claimable
        assert not telegram.can_add_chat

    async def test_an_admin_may_disconnect_everything(self) -> None:
        offered = await installable_platforms(
            _Session(),
            _Service(connected=True),
            True,  # type: ignore[arg-type]
        )
        (telegram,) = offered.claimable
        assert telegram.can_disconnect_all


class TestClaimLinks:
    async def test_a_member_gets_a_link_once_it_is_connected(self) -> None:
        started = await begin_claim(
            "telegram",
            _Session(),
            _Service(connected=True),
            _user(),
            False,  # type: ignore[arg-type]
        )
        assert started.url.startswith("https://t.me/")
        assert started.code == "c1code"
        assert started.bot_handle == "@switch_app_bot"

    async def test_a_member_cannot_turn_it_on(self) -> None:
        with pytest.raises(HTTPException) as refused:
            await begin_claim(
                "telegram",
                _Session(),
                _Service(connected=False),
                _user(),
                False,  # type: ignore[arg-type]
            )
        assert refused.value.status_code == 403

    async def test_an_admin_can(self) -> None:
        started = await begin_claim(
            "telegram",
            _Session(),
            _Service(connected=False),
            _user(),
            True,  # type: ignore[arg-type]
        )
        assert started.code == "c1code"

    async def test_an_oauth_platform_has_no_claim_link(self) -> None:
        with pytest.raises(HTTPException) as refused:
            await begin_claim(
                "slack",
                _Session(),
                _Service(),
                _user("admin"),
                True,  # type: ignore[arg-type]
            )
        assert refused.value.status_code == 404

    async def test_no_link_before_the_bot_has_connected(self) -> None:
        with pytest.raises(HTTPException) as refused:
            await begin_claim(
                "telegram",
                _Session(),  # type: ignore[arg-type]
                _Service(connected=True, not_ready=True),  # type: ignore[arg-type]
                _user(),
                False,
            )
        assert refused.value.status_code == 503


class TestOAuthIsATenantAdmins:
    async def test_a_member_cannot_start_an_oauth_install(self) -> None:
        with pytest.raises(HTTPException) as refused:
            await begin_install("slack", _Session(), _Service(), _user(), False)  # type: ignore[arg-type]
        assert refused.value.status_code == 403

    async def test_a_tenant_admin_can(self) -> None:
        started = await begin_install(
            "slack",
            _Session(),
            _Service(),
            _user(),
            True,  # type: ignore[arg-type]
        )
        assert started.authorize_url == "https://slack.example/authorize"

    async def test_a_member_cannot_disconnect_an_oauth_install(self) -> None:
        service = _Service()
        with tenant_scope(_TENANT), pytest.raises(HTTPException) as refused:
            await disconnect_install("s1", _Session(), service, _user(), False)  # type: ignore[arg-type]
        assert refused.value.status_code == 403
        assert service.disconnected == []


class TestChats:
    async def test_a_member_sees_only_the_chats(self) -> None:
        listed = await list_installs(_Session(), _Service(), False)  # type: ignore[arg-type]
        assert [i.platform for i in listed.installs] == ["telegram"]

    async def test_a_tenant_admin_sees_everything(self) -> None:
        listed = await list_installs(_Session(), _Service(), True)  # type: ignore[arg-type]
        assert [i.platform for i in listed.installs] == ["slack", "telegram"]

    async def test_each_is_listed_by_the_name_it_still_has(self) -> None:
        listed = await list_installs(_Session(), _Service(), True)  # type: ignore[arg-type]
        assert [(i.id, i.name) for i in listed.installs] == [
            ("s1", None),
            ("t1", "Telegram: news"),
        ]

    async def test_a_member_disconnects_one_chat(self) -> None:
        service = _Service()
        with tenant_scope(_TENANT):
            await disconnect_install("t1", _Session(), service, _user(), False)  # type: ignore[arg-type]
        assert service.disconnected == ["t1"]

    async def test_only_an_admin_disconnects_every_chat(self) -> None:
        service = _Service(connected=True)
        with tenant_scope(_TENANT), pytest.raises(HTTPException) as refused:
            await disconnect_platform("telegram", service, _user(), False)  # type: ignore[arg-type]
        assert refused.value.status_code == 403
        assert service.platforms_disconnected == []

    async def test_an_admin_disconnects_every_chat(self) -> None:
        service = _Service(connected=True)
        with tenant_scope(_TENANT):
            ended = await disconnect_platform("telegram", service, _user(), True)  # type: ignore[arg-type]
        assert service.platforms_disconnected == ["telegram"]
        assert [i.id for i in ended.installs] == ["t1"]
