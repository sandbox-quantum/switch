"""The security event stream: one log line per audit write, and a few events
that only ever reach the log.

The audit tables are the record, but they live only in Postgres, where
nothing can alert on them. Every write through `db/audit.py` therefore also
writes one INFO line on the `switch_core.security` logger, with `switch.event`
= `security.<action>` and the event's ids as `switch.*` fields, so a log
pipeline can alert per actor, tenant or room. Metrics carry none of those ids
on purpose (`observability/catalogue.py`); this is where they go instead.

An audit write's line is written only once the transaction holding it
commits: a change that rolls back, or a savepoint around it that rolls back,
leaves no line, as it leaves no row. The pending lines ride on the session
(`Session.info`) and the session's own transaction events decide them.

Some events have no transaction to ride on, or come too often for a row each:
a sign-in that failed, a budget refusing a message, the refusal breaker
tripping, a Switch Trust alert or error, and the access lines that
per-actor detection counts (messages an agent posts, rooms it reads, files,
service tokens). Those are written at once
with `log_security_event`, and are marked `switch.scope` = `log` so a reader
knows no audit row backs them.

`details` is the audit event's own, which holds identifiers and field names,
never secrets or message text; a log-only event follows the same rule.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from sqlalchemy import event as sa_event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

from switch_core.logging_context import STRUCTURED_FIELDS, StructuredValue

LOGGER_NAME = "switch_core.security"
logger = logging.getLogger(LOGGER_NAME)

EVENT_PREFIX = "security."

_PENDING = "switch_security_events_pending"
_COMMITTED = "switch_security_events_committed"
_WATCHED = "switch_security_events_watched"


class SecurityScope(StrEnum):
    """Which audit table backs an event, or `log` for none."""

    TENANT = "tenant"
    ORGANIZATION = "organization"
    SERVER = "server"
    LOG = "log"


class SecuritySignal(StrEnum):
    """Events written to the log only (see the module docstring)."""

    SIGN_IN_FAILED = "auth.sign_in_failed"
    BUDGET_EXCEEDED = "budget.exceeded"
    REFUSAL_BREAKER_TRIPPED = "refusal_breaker.tripped"
    # A Switch Trust verdict of `alerted` or `errored` (`trust/client.py`).
    TRUST_VERDICT = "trust.verdict"
    # Access an agent or person has, logged so one actor's volume can be
    # alerted on: a message an agent posted (`delivery/router.py`), a room
    # timeline an agent read or the rooms it listed
    # (`bridges/agent/operations/definitions.py`), a file stored or fetched,
    # and a service token issued to an agent (`connections/broker.py`).
    AGENT_MESSAGE_SENT = "agent.message_sent"
    AGENT_ROOM_READ = "agent.room_read"
    AGENT_ROOMS_LISTED = "agent.rooms_listed"
    ATTACHMENT_UPLOADED = "attachment.uploaded"
    ATTACHMENT_DOWNLOADED = "attachment.downloaded"
    SERVICE_TOKEN_ISSUED = "service_token.issued"


@dataclass(frozen=True)
class SecurityEvent:
    action: str
    scope: SecurityScope
    tenant_id: str | None
    organization_id: str | None
    actor_user_id: str | None
    target_type: str
    target_id: str | None
    agent_id: str | None
    room_id: str | None
    details: Mapping[str, Any] | None
    audit_event_id: str | None


def subject_ids(
    target_type: str, target_id: str | None, details: Mapping[str, Any] | None
) -> tuple[str | None, str | None]:
    """The agent and room an audit event concerns, where it names them: as its
    target, or as `agent_id` / `room_id` in its details."""
    found = dict(details or {})
    agent_id = target_id if target_type == "agent" else found.get("agent_id")
    room_id = target_id if target_type == "room" else found.get("room_id")
    return (
        None if agent_id is None else str(agent_id),
        None if room_id is None else str(room_id),
    )


def emit_after_commit(session: AsyncSession, event: SecurityEvent) -> None:
    """Write `event` once `session`'s transaction commits, and never if it, or
    the savepoint it was recorded in, rolls back."""
    sync = session.sync_session
    transaction = sync.get_nested_transaction() or sync.get_transaction()
    if transaction is None:
        raise RuntimeError(
            f"Security event {event.action} recorded outside a transaction; "
            "record it after the change it describes has been flushed."
        )
    _watch(sync)
    sync.info.setdefault(_PENDING, []).append((transaction, event))


def log_security_event(
    signal: SecuritySignal,
    *,
    tenant_id: str | None,
    actor_user_id: str | None,
    target_type: str,
    target_id: str | None,
    agent_id: str | None,
    room_id: str | None,
    details: Mapping[str, Any] | None,
) -> None:
    """Write a log-only event now."""
    write(
        SecurityEvent(
            action=signal.value,
            scope=SecurityScope.LOG,
            tenant_id=tenant_id,
            organization_id=None,
            actor_user_id=actor_user_id,
            target_type=target_type,
            target_id=target_id,
            agent_id=agent_id,
            room_id=room_id,
            details=details,
            audit_event_id=None,
        )
    )


def write(event: SecurityEvent) -> None:
    name = EVENT_PREFIX + event.action
    envelope: dict[str, StructuredValue] = {
        "event": name,
        "scope": event.scope.value,
        "action": event.action,
        "tenant_id": event.tenant_id,
        "organization_id": event.organization_id,
        "actor_user_id": event.actor_user_id,
        "target_type": event.target_type,
        "target_id": event.target_id,
        "agent_id": event.agent_id,
        "room_id": event.room_id,
        "audit_event_id": event.audit_event_id,
    }
    logger.info(
        # No `name=value` pairs: an id after `key=` or `token:` reads as a
        # credential to secret scanners such as gitleaks' generic-api-key.
        "%s by %s on %s %s in tenant %s",
        name,
        event.actor_user_id or "-",
        event.target_type,
        event.target_id or "-",
        event.tenant_id or "-",
        extra={
            STRUCTURED_FIELDS: {
                "switch": envelope,
                "security_details": flat_details(event.details),
            }
        },
    )


def flat_details(details: Mapping[str, Any] | None) -> dict[str, StructuredValue]:
    """One level of scalars, which is all a structured log group can carry to
    every exporter: a list or mapping becomes its JSON text."""
    flat: dict[str, StructuredValue] = {}
    for key, value in (details or {}).items():
        if "email" in str(key).lower():
            # Email addresses stay in the audit row and out of the log
            # pipeline, which keeps only pseudonymous ids.
            continue
        if value is None or isinstance(value, str | int | float | bool):
            flat[str(key)] = value
        else:
            flat[str(key)] = json.dumps(value, default=str, sort_keys=True)
    return flat


def _watch(sync: Session) -> None:
    if sync.info.get(_WATCHED):
        return
    sync.info[_WATCHED] = True
    sa_event.listen(sync, "after_commit", _on_commit)
    sa_event.listen(sync, "after_soft_rollback", _on_soft_rollback)
    sa_event.listen(sync, "after_transaction_end", _on_transaction_end)


def _on_commit(session: Session) -> None:
    # A savepoint's release fires this too, with the savepoint still current;
    # only the outermost commit makes the change durable.
    if not session.in_nested_transaction():
        session.info[_COMMITTED] = True


def _on_soft_rollback(
    session: Session, previous_transaction: SessionTransaction
) -> None:
    pending = session.info.get(_PENDING)
    if pending:
        session.info[_PENDING] = [
            (transaction, event)
            for transaction, event in pending
            if not _within(transaction, previous_transaction)
        ]


def _on_transaction_end(session: Session, transaction: SessionTransaction) -> None:
    if transaction.parent is not None:
        return
    pending = session.info.pop(_PENDING, [])
    committed = session.info.pop(_COMMITTED, False)
    if committed:
        for _transaction, event in pending:
            write(event)


def _within(transaction: SessionTransaction, ancestor: SessionTransaction) -> bool:
    current: SessionTransaction | None = transaction
    while current is not None:
        if current is ancestor:
            return True
        current = current.parent
    return False
