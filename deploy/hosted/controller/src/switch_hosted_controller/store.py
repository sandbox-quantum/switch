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
                observed_revision INTEGER NOT NULL DEFAULT 0,
                observed_operation_id TEXT,
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
        self._migrate_schema()
        self._bind_fingerprint(controller_fingerprint)

    def close(self) -> None:
        self._connection.close()

    def _migrate_schema(self) -> None:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            columns = {row["name"] for row in self._connection.execute("PRAGMA table_info(agents)")}
            if "observed_revision" not in columns:
                self._connection.execute(
                    "ALTER TABLE agents ADD COLUMN observed_revision INTEGER NOT NULL DEFAULT 0"
                )
            if "observed_operation_id" not in columns:
                self._connection.execute("ALTER TABLE agents ADD COLUMN observed_operation_id TEXT")
            self._connection.execute("COMMIT")
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

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
                    observed_state, observed_revision, observed_operation_id
                ) VALUES (?, 1, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?)
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
                    operation_id,
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
                or current.observed_revision != current.desired_revision
                or current.observed_operation_id != current.operation_id
            ):
                raise StoreError(
                    "agent must be desired and freshly observed stopped before deletion"
                )
            if desired is current.desired_state and (
                desired is not DesiredState.DELETED or delete_volume == current.delete_volume
            ):
                self._connection.execute("COMMIT")
                return current
            operation_id = str(uuid.uuid4())
            self._connection.execute(
                """
                UPDATE agents
                SET desired_state = ?, desired_revision = desired_revision + 1,
                    operation_id = ?, delete_volume = ?, observed_state = ?,
                    observed_revision = desired_revision + 1,
                    observed_operation_id = ?, last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE agent_id = ?
                """,
                (
                    desired.value,
                    operation_id,
                    int(delete_volume),
                    ObservedState.PENDING.value,
                    operation_id,
                    agent_id,
                ),
            )
            self._connection.execute("COMMIT")
            return self.get(agent_id)
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

    def mark_volume_create_intent(self, claim: Agent) -> Agent:
        return self._mark_intent(claim, "volume_create_intent")

    def mark_instance_launch_intent(self, claim: Agent) -> Agent:
        return self._mark_intent(claim, "instance_launch_intent")

    def mark_volume_create_issued(self, claim: Agent) -> Agent:
        return self._mark_intent(claim, "volume_create_issued")

    def mark_instance_launch_issued(self, claim: Agent) -> Agent:
        return self._mark_intent(claim, "instance_launch_issued")

    def cancel_queued_volume_create(self, claim: Agent) -> Agent:
        if claim.volume_create_issued:
            raise StoreError("cannot cancel an issued volume create")
        return self._cas_update(claim, "volume_create_intent = 0")

    def cancel_queued_instance_launch(self, claim: Agent) -> Agent:
        if claim.instance_launch_issued:
            raise StoreError("cannot cancel an issued instance launch")
        return self._cas_update(claim, "instance_launch_intent = 0")

    def mark_volume_delete_issued(self, claim: Agent) -> Agent:
        return self._mark_intent(claim, "volume_delete_issued")

    def record_volume(self, agent_id: str, volume_id: str, availability_zone: str) -> Agent:
        self._set_once(agent_id, "volume_id", volume_id, extra=("volume_az", availability_zone))
        return self.get(agent_id)

    def record_instance(self, agent_id: str, instance_id: str) -> Agent:
        self._set_once(agent_id, "instance_id", instance_id)
        return self.get(agent_id)

    def mark_instance_terminal_observed(self, agent_id: str, instance_id: str) -> Agent:
        cursor = self._connection.execute(
            """
            UPDATE agents SET instance_terminal_observed = 1, updated_at = CURRENT_TIMESTAMP
            WHERE agent_id = ? AND instance_id = ?
            """,
            (agent_id, instance_id),
        )
        current = self.get(agent_id)
        if cursor.rowcount != 1 and current.instance_id != instance_id:
            raise StoreError("terminal observation does not match recorded instance")
        return current

    def set_observed(
        self, claim: Agent, observed: ObservedState, last_error: str | None = None
    ) -> Agent:
        self._connection.execute(
            """
            UPDATE agents
            SET observed_state = ?, observed_revision = ?, observed_operation_id = ?,
                last_error = ?, updated_at = CURRENT_TIMESTAMP
            WHERE agent_id = ? AND desired_revision = ? AND operation_id = ?
            """,
            (
                observed.value,
                claim.desired_revision,
                claim.operation_id,
                last_error,
                claim.agent_id,
                claim.desired_revision,
                claim.operation_id,
            ),
        )
        return self.get(claim.agent_id)

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

    def _mark_intent(self, claim: Agent, column: str) -> Agent:
        if column not in {
            "volume_create_intent",
            "volume_create_issued",
            "instance_launch_intent",
            "instance_launch_issued",
            "volume_delete_issued",
        }:
            raise ValueError("invalid intent column")
        return self._cas_update(claim, f"{column} = 1")

    def _cas_update(self, claim: Agent, assignment: str) -> Agent:
        self._connection.execute(
            f"""
            UPDATE agents SET {assignment}, updated_at = CURRENT_TIMESTAMP
            WHERE agent_id = ? AND desired_revision = ? AND operation_id = ?
            """,
            (claim.agent_id, claim.desired_revision, claim.operation_id),
        )
        return self.get(claim.agent_id)

    def _set_once(
        self, agent_id: str, column: str, value: str, extra: tuple[str, str] | None = None
    ) -> None:
        if column not in {"instance_id", "volume_id"}:
            raise ValueError("invalid set-once column")
        self._connection.execute("BEGIN IMMEDIATE")
        try:
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
            self._connection.execute("COMMIT")
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise


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
        observed_revision=row["observed_revision"],
        observed_operation_id=row["observed_operation_id"],
        last_error=row["last_error"],
        delete_volume=bool(row["delete_volume"]),
        volume_create_intent=bool(row["volume_create_intent"]),
        volume_create_issued=bool(row["volume_create_issued"]),
        instance_launch_intent=bool(row["instance_launch_intent"]),
        instance_launch_issued=bool(row["instance_launch_issued"]),
        instance_terminal_observed=bool(row["instance_terminal_observed"]),
        volume_delete_issued=bool(row["volume_delete_issued"]),
    )
