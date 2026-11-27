"""A managed agent whose controller is connected but gave up on its agent
host. The controller counts as live, so no "offline" notice was ever posted,
and the message reached nobody (22-23 Oct: "Agent host failed too
often; it stays down until restarted", messages unanswered for 240 s and
counting while the machine showed online). Driven through `decide_message`
and `_after_message`, the path a mention takes."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, AgentController, TenantMember, User
from switch_core.delivery.recipient import AgentRecipient
from tests.switch_core.delivery.test_no_session_reply_threading import (
    _deliver,
    _event,
    _fake_self,
    _Recorder,
)

GAVE_UP = (
    "I can't reply right now. I stopped after failing to start several times. "
    "My owner (@owner) can restart me from Your Agents in Switch Console. "
    "I've kept your message, so there's no need to send it again. I'll answer "
    "when I'm back."
)


def _connected_managed_agent(
    send_message: _Recorder, *, bound: bool = True, failure: str | None = "internal"
) -> tuple[SimpleNamespace, list[str]]:
    fake = _fake_self(send_message)
    reads: list[str] = []

    async def _is_available(_session: object, _agent: object, _room_id: str) -> bool:
        return True  # its controller is connected

    async def _agent_host_failure(controller_id: str) -> str | None:
        reads.append(controller_id)
        return failure

    async def owner_handle_in(*_args: object) -> str | None:
        return "owner"

    binding = SimpleNamespace(controller_id="controller-1", running=True)
    fake._is_available = _is_available
    fake._agent_host_failure = _agent_host_failure
    fake.owner_handle_in = owner_handle_in
    fake._connections = SimpleNamespace(
        controllers=SimpleNamespace(
            is_bound=lambda _agent_id: bound,
            binding=lambda _agent_id: binding if bound else None,
        )
    )
    fake._controller_host_failed_reply = (
        AgentRecipient._controller_host_failed_reply.__get__(fake)
    )
    return fake, reads


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.asyncio
async def test_a_connected_agent_whose_host_gave_up_tells_the_room() -> None:
    send_message = _Recorder()
    fake, reads = _connected_managed_agent(send_message)
    await _deliver(fake, _event(thread_id=None))

    assert reads == ["controller-1"]
    assert len(send_message.calls) == 1
    assert send_message.calls[0]["body"] == f"@louisa {GAVE_UP}"


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.asyncio
async def test_any_other_failure_names_no_cure_but_says_the_message_is_kept() -> None:
    send_message = _Recorder()
    fake, _reads = _connected_managed_agent(
        send_message, failure="provider_login_expired"
    )
    await _deliver(fake, _event(thread_id=None))

    assert send_message.calls[0]["body"] == (
        "@louisa I can't reply right now. I'm not running on my machine. "
        "My owner (@owner) can see why in Your Agents in Switch Console. I've kept "
        "your message, so there's no need to send it again. I'll answer when I'm back."
    )


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.asyncio
async def test_a_connected_agent_whose_host_is_running_gets_no_notice() -> None:
    send_message = _Recorder()
    fake, reads = _connected_managed_agent(send_message, failure=None)
    await _deliver(fake, _event(thread_id=None))

    assert reads == ["controller-1"]
    assert send_message.calls == []


@pytest.mark.asyncio
async def test_an_agent_no_controller_runs_is_not_read_for_a_failure() -> None:
    send_message = _Recorder()
    fake, reads = _connected_managed_agent(send_message, bound=False)
    await _deliver(fake, _event(thread_id=None))

    assert reads == []
    assert send_message.calls == []


async def test_the_failure_is_read_from_the_agents_own_entry_in_its_controllers_report(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Against real Postgres: the stored report the controller sent, with the
    That failure for one agent and a healthy entry for another."""
    async with session_factory() as session:
        owner = User(
            name="ada", email=f"ada-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
        )
        session.add(owner)
        await session.flush()
        session.add(
            TenantMember(tenant_id=TENANT_ZERO_ID, user_id=owner.id, role="member")
        )
        controller = AgentController(owner_id=owner.id, name="laptop", kind="console")
        session.add(controller)
        await session.flush()
        controller.status = {
            "agents": [
                {
                    "agent_id": "gave-up",
                    "process": "failed",
                    "attached": False,
                    "reason": "internal",
                    "detail": "The shared SDK watcher is already running.",
                },
                {"agent_id": "healthy", "process": "running", "attached": True},
            ]
        }
        controller_id = controller.id
        await session.commit()

    def recipient(agent_id: str) -> SimpleNamespace:
        ns = SimpleNamespace(
            agent=SimpleNamespace(id=agent_id),
            session_factory=session_factory,
            tenant_id=TENANT_ZERO_ID,
        )
        ns._agent_host_failure = AgentRecipient._agent_host_failure.__get__(ns)
        return ns

    assert await recipient("gave-up")._agent_host_failure(controller_id) == "internal"
    assert await recipient("healthy")._agent_host_failure(controller_id) is None
    assert await recipient("unreported")._agent_host_failure(controller_id) is None
    assert await recipient("gave-up")._agent_host_failure(str(uuid.uuid4())) is None
