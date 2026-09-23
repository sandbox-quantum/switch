"""Best-effort command wakeups, published only after their transaction commits.

The durable command queue remains authoritative. Disconnected workers recover
by checking it on startup and periodically; these notifications carry no work.
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager

from sqlalchemy import event
from sqlalchemy.orm import Session

_KEY = "switch_command_notifications"
_listeners: dict[tuple[str, str], set[Callable[[str], None]]] = {}


@contextmanager
def subscribe(
    tenant_id: str, agent_id: str, notify: Callable[[str], None]
) -> Iterator[None]:
    key = (tenant_id, agent_id)
    listeners = _listeners.setdefault(key, set())
    listeners.add(notify)
    try:
        yield
    finally:
        listeners.discard(notify)
        if not listeners:
            _listeners.pop(key, None)


def schedule(session: Session, tenant_id: str, agent_id: str, session_id: str) -> None:
    session.info.setdefault(_KEY, set()).add((tenant_id, agent_id, session_id))


@event.listens_for(Session, "after_commit")
def _committed(session: Session) -> None:
    for tenant_id, agent_id, session_id in session.info.pop(_KEY, set()):
        for notify in tuple(_listeners.get((tenant_id, agent_id), ())):
            notify(session_id)


@event.listens_for(Session, "after_rollback")
def _rolled_back(session: Session) -> None:
    session.info.pop(_KEY, None)
