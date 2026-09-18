from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

from .model import Agent, DesiredState, ObservedState


class StoreError(RuntimeError):
    pass


class CapacityError(StoreError):
    pass


class ImmutableSpecError(StoreError):
    pass


class AgentNotFoundError(StoreError):
    pass


class AgentStore:
    def __init__(self, path: Path, controller_fingerprint: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(path, timeout=30, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS agents (
                agent_id TEXT PRIMARY KEY,
                generation INTEGER NOT NULL CHECK (generation > 0),
                desired_state TEXT NOT NULL,
                desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
                operation_id TEXT NOT NULL,
                instance_type TEXT NOT NULL,
                image_id TEXT NOT NULL,
                assignment_secret_arn TEXT NOT NULL,
                instance_profile_arn TEXT NOT NULL,
                instance_id TEXT,
                volume_id TEXT,
                volume_az TEXT,
                observed_state TEXT NOT NULL,
                last_error TEXT,
                delete_volume INTEGER NOT NULL DEFAULT 0,
                volume_create_intent INTEGER NOT NULL DEFAULT 0,
                volume_create_issued INTEGER NOT NULL DEFAULT 0,
                instance_launch_intent INTEGER NOT NULL DEFAULT 0,
                instance_launch_issued INTEGER NOT NULL DEFAULT 0,
                instance_terminal_observed INTEGER NOT NULL DEFAULT 0,
                volume_delete_issued INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS controller_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        self._bind_fingerprint(controller_fingerprint)

    def close(self) -> None:
        self._connection.close()

    def _bind_fingerprint(self, fingerprint: str) -> None:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            row = self._connection.execute(
                "SELECT value FROM controller_metadata WHERE key = ?",
                ("controller_fingerprint",),
            ).fetchone()
            if row is None:
                self._connection.execute(
                    "INSERT INTO controller_metadata (key, value) VALUES (?, ?)",
                    ("controller_fingerprint", fingerprint),
                )
            elif row["value"] != fingerprint:
                raise StoreError(
                    "controller immutable configuration differs from the state database"
                )
            self._connection.execute("COMMIT")
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

    def reserve_create(
        self,
        *,
        agent_id: str,
        instance_type: str,
        image_id: str,
        assignment_secret_arn: str,
        instance_profile_arn: str,
        max_agents: int,
    ) -> Agent:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            row = self._connection.execute(
                "SELECT * FROM agents WHERE agent_id = ?", (agent_id,)
            ).fetchone()
            if row is not None:
                existing = _agent(row)
                expected = (
                    instance_type,
                    image_id,
                    assignment_secret_arn,
                    instance_profile_arn,
                )
                actual = (
                    existing.instance_type,
                    existing.image_id,
                    existing.assignment_secret_arn,
                    existing.instance_profile_arn,
                )
                if existing.desired_state is DesiredState.DELETED:
                    raise ImmutableSpecError("deleted agent IDs cannot be reused")
                if actual != expected:
                    raise ImmutableSpecError("an existing agent's immutable spec cannot be changed")
                self._connection.execute("COMMIT")
                return existing
            count = self._connection.execute(
                "SELECT COUNT(*) FROM agents WHERE desired_state != ?",
                (DesiredState.DELETED.value,),
            ).fetchone()[0]
            if count >= max_agents:
                raise CapacityError(f"configured capacity of {max_agents} agents is exhausted")
            operation_id = str(uuid.uuid4())
            self._connection.execute(
                """
                INSERT INTO agents (
                    agent_id, generation, desired_state, desired_revision, operation_id,
                    instance_type, image_id, assignment_secret_arn, instance_profile_arn,
                    observed_state
                ) VALUES (?, 1, ?, 1, ?, ?, ?, ?, ?, ?)
                """,
                (
                    agent_id,
                    DesiredState.RUNNING.value,
                    operation_id,
                    instance_type,
                    image_id,
                    assignment_secret_arn,
                    instance_profile_arn,
                    ObservedState.PENDING.value,
                ),
            )
            self._connection.execute("COMMIT")
            return self.get(agent_id)
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

    def set_desired(
        self, agent_id: str, desired: DesiredState, *, delete_volume: bool = False
    ) -> Agent:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            current = self._get_row(agent_id)
            if current.desired_state is DesiredState.DELETED:
                if desired is not DesiredState.DELETED:
                    raise StoreError("a deleted agent cannot be restarted")
                self._connection.execute("COMMIT")
                return current
            if desired is DesiredState.DELETED and (
                current.desired_state is not DesiredState.STOPPED
                or current.observed_state is not ObservedState.STOPPED
            ):
                raise StoreError("agent must be desired and observed stopped before deletion")
            if desired is current.desired_state and (
                desired is not DesiredState.DELETED or delete_volume == current.delete_volume
            ):
                self._connection.execute("COMMIT")
                return current
            self._connection.execute(
                """
                UPDATE agents
                SET desired_state = ?, desired_revision = desired_revision + 1,
                    operation_id = ?, delete_volume = ?, last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE agent_id = ?
                """,
                (desired.value, str(uuid.uuid4()), int(delete_volume), agent_id),
            )
            self._connection.execute("COMMIT")
            return self.get(agent_id)
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

    def mark_volume_create_intent(self, agent_id: str) -> Agent:
        self._mark_intent(agent_id, "volume_create_intent")
        return self.get(agent_id)

    def mark_instance_launch_intent(self, agent_id: str) -> Agent:
        self._mark_intent(agent_id, "instance_launch_intent")
        return self.get(agent_id)

    def mark_volume_create_issued(self, agent_id: str) -> Agent:
        self._mark_intent(agent_id, "volume_create_issued")
        return self.get(agent_id)

    def mark_instance_launch_issued(self, agent_id: str) -> Agent:
        self._mark_intent(agent_id, "instance_launch_issued")
        return self.get(agent_id)

    def cancel_queued_volume_create(self, agent_id: str) -> Agent:
        current = self.get(agent_id)
        if current.volume_create_issued:
            raise StoreError("cannot cancel an issued volume create")
        self._connection.execute(
            "UPDATE agents SET volume_create_intent = 0, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
            (agent_id,),
        )
        return self.get(agent_id)

    def cancel_queued_instance_launch(self, agent_id: str) -> Agent:
        current = self.get(agent_id)
        if current.instance_launch_issued:
            raise StoreError("cannot cancel an issued instance launch")
        self._connection.execute(
            "UPDATE agents SET instance_launch_intent = 0, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
            (agent_id,),
        )
        return self.get(agent_id)

    def mark_volume_delete_issued(self, agent_id: str) -> Agent:
        self._mark_intent(agent_id, "volume_delete_issued")
        return self.get(agent_id)

    def record_volume(self, agent_id: str, volume_id: str, availability_zone: str) -> Agent:
        self._set_once(agent_id, "volume_id", volume_id, extra=("volume_az", availability_zone))
        return self.get(agent_id)

    def record_instance(self, agent_id: str, instance_id: str) -> Agent:
        self._set_once(agent_id, "instance_id", instance_id)
        return self.get(agent_id)

    def mark_instance_terminal_observed(self, agent_id: str) -> Agent:
        cursor = self._connection.execute(
            "UPDATE agents SET instance_terminal_observed = 1, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
            (agent_id,),
        )
        if cursor.rowcount != 1:
            raise AgentNotFoundError(agent_id)
        return self.get(agent_id)

    def set_observed(
        self, agent_id: str, observed: ObservedState, last_error: str | None = None
    ) -> Agent:
        cursor = self._connection.execute(
            """
            UPDATE agents SET observed_state = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
            WHERE agent_id = ?
            """,
            (observed.value, last_error, agent_id),
        )
        if cursor.rowcount != 1:
            raise AgentNotFoundError(agent_id)
        return self.get(agent_id)

    def get(self, agent_id: str) -> Agent:
        return self._get_row(agent_id)

    def list(self) -> list[Agent]:
        return [
            _agent(row)
            for row in self._connection.execute("SELECT * FROM agents ORDER BY agent_id")
        ]

    def _get_row(self, agent_id: str) -> Agent:
        row = self._connection.execute(
            "SELECT * FROM agents WHERE agent_id = ?", (agent_id,)
        ).fetchone()
        if row is None:
            raise AgentNotFoundError(f"unknown agent {agent_id!r}")
        return _agent(row)

    def _mark_intent(self, agent_id: str, column: str) -> None:
        if column not in {
            "volume_create_intent",
            "volume_create_issued",
            "instance_launch_intent",
            "instance_launch_issued",
            "volume_delete_issued",
        }:
            raise ValueError("invalid intent column")
        cursor = self._connection.execute(
            f"UPDATE agents SET {column} = 1, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
            (agent_id,),
        )
        if cursor.rowcount != 1:
            raise AgentNotFoundError(agent_id)

    def _set_once(
        self, agent_id: str, column: str, value: str, extra: tuple[str, str] | None = None
    ) -> None:
        if column not in {"instance_id", "volume_id"}:
            raise ValueError("invalid set-once column")
        current = self._get_row(agent_id)
        existing = getattr(current, column)
        if existing is not None and existing != value:
            raise StoreError(f"refusing to replace recorded {column}")
        assignments = [f"{column} = ?", "updated_at = CURRENT_TIMESTAMP"]
        values: list[str] = [value]
        if extra is not None:
            extra_column, extra_value = extra
            if extra_column != "volume_az":
                raise ValueError("invalid extra column")
            assignments.insert(1, f"{extra_column} = ?")
            values.append(extra_value)
        values.append(agent_id)
        self._connection.execute(
            f"UPDATE agents SET {', '.join(assignments)} WHERE agent_id = ?", values
        )


def _agent(row: sqlite3.Row) -> Agent:
    return Agent(
        agent_id=row["agent_id"],
        generation=row["generation"],
        desired_state=DesiredState(row["desired_state"]),
        desired_revision=row["desired_revision"],
        operation_id=row["operation_id"],
        instance_type=row["instance_type"],
        image_id=row["image_id"],
        assignment_secret_arn=row["assignment_secret_arn"],
        instance_profile_arn=row["instance_profile_arn"],
        instance_id=row["instance_id"],
        volume_id=row["volume_id"],
        volume_az=row["volume_az"],
        observed_state=ObservedState(row["observed_state"]),
        last_error=row["last_error"],
        delete_volume=bool(row["delete_volume"]),
        volume_create_intent=bool(row["volume_create_intent"]),
        volume_create_issued=bool(row["volume_create_issued"]),
        instance_launch_intent=bool(row["instance_launch_intent"]),
        instance_launch_issued=bool(row["instance_launch_issued"]),
        instance_terminal_observed=bool(row["instance_terminal_observed"]),
        volume_delete_issued=bool(row["volume_delete_issued"]),
    )
