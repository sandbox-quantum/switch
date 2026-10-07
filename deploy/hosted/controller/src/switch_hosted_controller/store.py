from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from .model import DesiredState, Machine, ObservedState

LEGACY_ROWS_MESSAGE = (
    "legacy per-agent rows present; see 'Moving to one machine per user' in deploy/hosted/README.md"
)


RECOVERY_LIMIT = 3


class StoreError(RuntimeError):
    pass


class CapacityError(StoreError):
    pass


class SlotInUseError(StoreError):
    pass


class MachineNotFoundError(StoreError):
    pass


@dataclass(frozen=True)
class GrantRecord:
    """The login-key grant of one slot generation.

    The row is written before CreateGrant is issued, so a grant whose creation
    outcome is unknown still has a row (with no `grant_id`) and is retired later.
    """

    slot_id: str
    generation: int
    key_arn: str
    grantee_arn: str
    grant_id: str | None
    grant_token: str | None = field(repr=False)
    retired: bool


_ADDED_MACHINE_COLUMNS = {
    "runtime": "runtime TEXT NOT NULL DEFAULT 'worker' CHECK (runtime IN ('worker', 'controller'))",
    "target_runtime": (
        "target_runtime TEXT NOT NULL DEFAULT 'worker'"
        " CHECK (target_runtime IN ('worker', 'controller'))"
    ),
    "target_image_id": "target_image_id TEXT",
}


class MachineStore:
    def __init__(self, path: Path, controller_fingerprint: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(path, timeout=30, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._refuse_legacy_rows()
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS machines (
                machine_id TEXT NOT NULL UNIQUE,
                slot_id TEXT NOT NULL,
                generation INTEGER NOT NULL CHECK (generation >= 1),
                desired_state TEXT NOT NULL
                    CHECK (desired_state IN ('running', 'stopped', 'retained', 'deleted')),
                observed_state TEXT NOT NULL,
                core_revision INTEGER NOT NULL CHECK (core_revision >= 0),
                desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
                operation_id TEXT NOT NULL,
                instance_type TEXT NOT NULL,
                image_id TEXT NOT NULL,
                assignment_secret_arn TEXT NOT NULL,
                instance_profile_arn TEXT NOT NULL,
                instance_seq INTEGER NOT NULL DEFAULT 0,
                recovery_count INTEGER NOT NULL DEFAULT 0,
                data_volume_id TEXT,
                volume_az TEXT,
                instance_id TEXT,
                previous_instance_id TEXT,
                previous_runtime_fingerprint TEXT,
                retain_until TEXT,
                observed_revision INTEGER NOT NULL DEFAULT 0,
                observed_operation_id TEXT,
                volume_create_intent INTEGER NOT NULL DEFAULT 0,
                volume_create_issued INTEGER NOT NULL DEFAULT 0,
                instance_launch_intent INTEGER NOT NULL DEFAULT 0,
                instance_launch_issued INTEGER NOT NULL DEFAULT 0,
                instance_launch_issued_at TEXT,
                instance_terminate_issued INTEGER NOT NULL DEFAULT 0,
                instance_terminal_observed INTEGER NOT NULL DEFAULT 0,
                volume_delete_issued INTEGER NOT NULL DEFAULT 0,
                required_bundle_revision INTEGER,
                required_bundle_token TEXT,
                bundle_token TEXT,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (slot_id, generation)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS machines_one_live_row_per_slot
                ON machines (slot_id) WHERE observed_state <> 'deleted';
            CREATE TABLE IF NOT EXISTS controller_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kms_grants (
                slot_id TEXT NOT NULL,
                generation INTEGER NOT NULL CHECK (generation >= 1),
                key_arn TEXT NOT NULL,
                grantee_arn TEXT NOT NULL,
                grant_id TEXT,
                grant_token TEXT,
                retired INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (slot_id, generation)
            );
            """
        )
        self._add_missing_columns()
        self._bind_fingerprint(controller_fingerprint)

    def close(self) -> None:
        self._connection.close()

    def _refuse_legacy_rows(self) -> None:
        legacy = self._connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'"
        ).fetchone()
        if legacy is None:
            return
        live = self._connection.execute(
            "SELECT COUNT(*) FROM agents WHERE desired_state <> 'deleted' OR observed_state <> 'deleted'"
        ).fetchone()[0]
        if live:
            self._connection.close()
            raise StoreError(LEGACY_ROWS_MESSAGE)

    def _add_missing_columns(self) -> None:
        present = {row["name"] for row in self._connection.execute("PRAGMA table_info(machines)")}
        for column, definition in _ADDED_MACHINE_COLUMNS.items():
            if column not in present:
                self._connection.execute(f"ALTER TABLE machines ADD COLUMN {definition}")

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

    def insert(
        self,
        *,
        machine_id: str,
        slot_id: str,
        generation: int,
        core_revision: int,
        instance_type: str,
        image_id: str,
        assignment_secret_arn: str,
        instance_profile_arn: str,
        max_machines: int,
    ) -> Machine:
        """Insert a machine for a slot whose earlier generations are all observed deleted."""
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            if self._connection.execute(
                "SELECT 1 FROM machines WHERE machine_id = ?", (machine_id,)
            ).fetchone():
                raise StoreError(f"machine {machine_id!r} already exists")
            latest = self._connection.execute(
                "SELECT MAX(generation) FROM machines WHERE slot_id = ?", (slot_id,)
            ).fetchone()[0]
            if latest is not None and generation <= latest:
                raise StoreError(
                    f"slot {slot_id!r} generation {generation} is not newer than stored generation {latest}"
                )
            live = self._connection.execute(
                "SELECT generation FROM machines WHERE slot_id = ? AND observed_state <> ?",
                (slot_id, ObservedState.DELETED.value),
            ).fetchone()
            if live is not None:
                raise SlotInUseError(
                    f"slot {slot_id!r} still has generation {live['generation']} that is not deleted"
                )
            count = self._connection.execute(
                "SELECT COUNT(*) FROM machines WHERE desired_state != ?",
                (DesiredState.DELETED.value,),
            ).fetchone()[0]
            if count >= max_machines:
                raise CapacityError(f"configured capacity of {max_machines} machines is exhausted")
            operation_id = str(uuid.uuid4())
            self._connection.execute(
                """
                INSERT INTO machines (
                    machine_id, slot_id, generation, desired_state, observed_state,
                    core_revision, desired_revision, operation_id, instance_type, image_id,
                    assignment_secret_arn, instance_profile_arn, observed_revision,
                    observed_operation_id
                ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ?)
                """,
                (
                    machine_id,
                    slot_id,
                    generation,
                    DesiredState.RUNNING.value,
                    ObservedState.PENDING.value,
                    core_revision,
                    operation_id,
                    instance_type,
                    image_id,
                    assignment_secret_arn,
                    instance_profile_arn,
                    operation_id,
                ),
            )
            self._connection.execute("COMMIT")
            return self.get(machine_id)
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

    def next_generation(self, slot_id: str) -> int:
        latest = self._connection.execute(
            "SELECT MAX(generation) FROM machines WHERE slot_id = ?", (slot_id,)
        ).fetchone()[0]
        return 1 if latest is None else latest + 1

    def record_core_revision(self, machine_id: str, revision: int) -> Machine:
        """Record Core's revision; an older one than already recorded leaves the machine unchanged."""
        self._connection.execute(
            """
            UPDATE machines SET core_revision = ?, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND core_revision < ?
            """,
            (revision, machine_id, revision),
        )
        return self.get(machine_id)

    def set_desired(
        self, machine_id: str, desired: DesiredState, retain_until: datetime | None
    ) -> Machine:
        """Change the desired state, and with it the retention deadline.

        Once a machine is desired deleted its deadline only ever moves later, so
        nothing can bring its volume deletion forward.
        """
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            current = self._get_row(machine_id)
            if current.desired_state is DesiredState.DELETED:
                if desired is not DesiredState.DELETED:
                    raise StoreError("a deleted machine cannot be restarted")
                later = _later(current.retain_until, retain_until)
                if later != current.retain_until:
                    self._update_retain_until(machine_id, later)
                self._connection.execute("COMMIT")
                return self.get(machine_id)
            if desired is DesiredState.DELETED and not (
                current.desired_state in {DesiredState.STOPPED, DesiredState.RETAINED}
                and current.observed_state.value == current.desired_state.value
                and current.observed_revision == current.desired_revision
                and current.observed_operation_id == current.operation_id
            ):
                raise StoreError(
                    "machine must be desired and freshly observed stopped or retained before deletion"
                )
            if desired is current.desired_state:
                if retain_until != current.retain_until:
                    self._update_retain_until(machine_id, retain_until)
                self._connection.execute("COMMIT")
                return self.get(machine_id)
            operation_id = str(uuid.uuid4())
            self._connection.execute(
                """
                UPDATE machines
                SET desired_state = ?, desired_revision = desired_revision + 1,
                    operation_id = ?, retain_until = ?, observed_state = ?,
                    observed_revision = desired_revision + 1,
                    observed_operation_id = ?, recovery_count = 0, error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE machine_id = ?
                """,
                (
                    desired.value,
                    operation_id,
                    _timestamp(retain_until),
                    ObservedState.PENDING.value,
                    operation_id,
                    machine_id,
                ),
            )
            self._connection.execute("COMMIT")
            return self.get(machine_id)
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

    def _update_retain_until(self, machine_id: str, retain_until: datetime | None) -> None:
        self._connection.execute(
            "UPDATE machines SET retain_until = ?, updated_at = CURRENT_TIMESTAMP WHERE machine_id = ?",
            (_timestamp(retain_until), machine_id),
        )

    def mark_volume_create_intent(self, claim: Machine) -> Machine:
        return self._mark_intent(claim, "volume_create_intent")

    def upgrade_terminated(
        self, claim: Machine, image_id: str, previous_runtime_fingerprint: str
    ) -> Machine:
        """Move a stopped machine onto `image_id`, superseding a pending image change."""
        if (
            claim.desired_state is not DesiredState.STOPPED
            or not claim.instance_id
            or not claim.instance_terminal_observed
        ):
            raise StoreError(
                "image upgrades require a stopped machine and confirmed terminated predecessor"
            )
        if image_id == claim.image_id:
            raise StoreError("the machine already uses this image")
        cursor = self._connection.execute(
            """UPDATE machines SET previous_instance_id = instance_id, instance_id = NULL,
            image_id = ?,
            target_image_id = NULL,
            previous_runtime_fingerprint = ?, instance_seq = instance_seq + 1,
            desired_revision = desired_revision + 1, operation_id = ?,
            instance_launch_intent = 0, instance_launch_issued = 0, instance_launch_issued_at = NULL,
            instance_terminate_issued = 0,
            instance_terminal_observed = 0, observed_state = 'stopped', error = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND desired_revision = ? AND operation_id = ?
            AND desired_state = 'stopped' AND instance_id = ? AND instance_terminal_observed = 1""",
            (
                image_id,
                previous_runtime_fingerprint,
                str(uuid.uuid4()),
                claim.machine_id,
                claim.desired_revision,
                claim.operation_id,
                claim.instance_id,
            ),
        )
        if cursor.rowcount != 1:
            raise StoreError("machine state changed during image upgrade; refresh before retrying")
        return self.get(claim.machine_id)

    def replace_terminated(self, claim: Machine, *, unexpected: bool) -> Machine:
        """Launch a successor to a terminated instance.

        Only an `unexpected` termination, one the controller did not cause,
        counts toward the recovery limit of the current operation.
        """
        if not claim.instance_terminal_observed or not claim.instance_id:
            raise StoreError("replacement requires a confirmed terminated predecessor")
        if unexpected:
            require_recovery_allowed(claim)
        self._connection.execute(
            """UPDATE machines SET previous_instance_id = instance_id, instance_id = NULL,
            previous_runtime_fingerprint = NULL, instance_seq = instance_seq + 1,
            recovery_count = recovery_count + ?, instance_launch_intent = 0,
            instance_launch_issued = 0, instance_launch_issued_at = NULL,
            instance_terminate_issued = 0,
            instance_terminal_observed = 0,
            observed_state = 'provisioning', error = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND desired_revision = ? AND operation_id = ?
            AND desired_state = 'running' AND instance_id = ? AND instance_terminal_observed = 1""",
            (
                1 if unexpected else 0,
                claim.machine_id,
                claim.desired_revision,
                claim.operation_id,
                claim.instance_id,
            ),
        )
        return self.get(claim.machine_id)

    def request_image(self, machine_id: str, image_id: str) -> Machine:
        """Record the image the machine should run.

        An image other than the current one is applied by `switch_image` once
        the current instance is gone.
        """
        self._connection.execute(
            """
            UPDATE machines SET
                target_image_id = CASE WHEN image_id != ? THEN ? ELSE NULL END,
                updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ?
            """,
            (image_id, image_id, machine_id),
        )
        return self.get(machine_id)

    def switch_image(self, claim: Machine) -> Machine:
        """Adopt the requested image for the next instance.

        The machine must have no instance, or a confirmed terminated one, which
        becomes the predecessor whose data volume the next instance reattaches.
        """
        if claim.target_image_id is None:
            raise StoreError("no image change is pending")
        if claim.instance_id is not None and not claim.instance_terminal_observed:
            raise StoreError("an image change requires a confirmed terminated predecessor")
        if claim.instance_id is None and claim.instance_launch_issued:
            raise StoreError("an image change cannot overtake an issued launch")
        cursor = self._connection.execute(
            """UPDATE machines SET image_id = target_image_id,
            target_image_id = NULL,
            previous_instance_id = COALESCE(instance_id, previous_instance_id), instance_id = NULL,
            previous_runtime_fingerprint = NULL, instance_seq = instance_seq + 1,
            instance_launch_intent = 0, instance_launch_issued = 0, instance_launch_issued_at = NULL,
            instance_terminate_issued = 0, instance_terminal_observed = 0,
            observed_state = 'provisioning', error = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND desired_revision = ? AND operation_id = ?
            AND desired_state = 'running' AND target_image_id = ?
            AND instance_id IS ?""",
            (
                claim.machine_id,
                claim.desired_revision,
                claim.operation_id,
                claim.target_image_id,
                claim.instance_id,
            ),
        )
        if cursor.rowcount != 1:
            raise StoreError("machine state changed during image change; refresh before retrying")
        return self.get(claim.machine_id)

    def release_terminated(self, claim: Machine) -> Machine:
        """Forget a retained machine's terminated instance so a later start launches a new one."""
        if not claim.instance_terminal_observed or not claim.instance_id:
            raise StoreError("release requires a confirmed terminated instance")
        self._connection.execute(
            """UPDATE machines SET previous_instance_id = instance_id, instance_id = NULL,
            previous_runtime_fingerprint = NULL, instance_seq = instance_seq + 1,
            instance_launch_intent = 0, instance_launch_issued = 0, instance_launch_issued_at = NULL,
            instance_terminate_issued = 0,
            instance_terminal_observed = 0, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND desired_revision = ? AND operation_id = ?
            AND desired_state = 'retained' AND instance_id = ? AND instance_terminal_observed = 1""",
            (claim.machine_id, claim.desired_revision, claim.operation_id, claim.instance_id),
        )
        return self.get(claim.machine_id)

    def mark_instance_launch_intent(self, claim: Machine) -> Machine:
        return self._mark_intent(claim, "instance_launch_intent")

    def mark_volume_create_issued(self, claim: Machine) -> Machine:
        return self._mark_intent(claim, "volume_create_issued")

    def mark_instance_launch_issued(self, claim: Machine, issued_at: datetime) -> Machine:
        self._connection.execute(
            """
            UPDATE machines SET instance_launch_issued = 1, instance_launch_issued_at = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND desired_revision = ? AND operation_id = ?
            """,
            (_timestamp(issued_at), claim.machine_id, claim.desired_revision, claim.operation_id),
        )
        return self.get(claim.machine_id)

    def cancel_queued_volume_create(self, claim: Machine) -> Machine:
        if claim.volume_create_issued:
            raise StoreError("cannot cancel an issued volume create")
        return self._cas_update(claim, "volume_create_intent = 0")

    def cancel_queued_instance_launch(self, claim: Machine) -> Machine:
        if claim.instance_launch_issued:
            raise StoreError("cannot cancel an issued instance launch")
        return self._cas_update(claim, "instance_launch_intent = 0")

    def clear_rejected_volume_create(self, claim: Machine) -> Machine:
        """Forget an issued volume create that EC2 definitely did not accept."""
        self._connection.execute(
            """
            UPDATE machines SET volume_create_issued = 0, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND data_volume_id IS NULL AND volume_create_issued = 1
            """,
            (claim.machine_id,),
        )
        return self.get(claim.machine_id)

    def clear_unlaunched_instance(self, claim: Machine) -> Machine:
        """Forget an issued launch of `claim.instance_seq` that produced no instance."""
        self._connection.execute(
            """
            UPDATE machines SET instance_launch_issued = 0, instance_launch_issued_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND instance_seq = ? AND instance_id IS NULL
            AND instance_launch_issued = 1
            """,
            (claim.machine_id, claim.instance_seq),
        )
        return self.get(claim.machine_id)

    def mark_instance_terminate_issued(self, claim: Machine) -> Machine:
        return self._mark_intent(claim, "instance_terminate_issued")

    def mark_volume_delete_issued(self, claim: Machine) -> Machine:
        return self._mark_intent(claim, "volume_delete_issued")

    def record_volume(self, machine_id: str, volume_id: str, availability_zone: str) -> Machine:
        self._set_once(
            machine_id, "data_volume_id", volume_id, extra=("volume_az", availability_zone)
        )
        return self.get(machine_id)

    def record_instance(self, machine_id: str, instance_id: str) -> Machine:
        self._set_once(machine_id, "instance_id", instance_id)
        return self.get(machine_id)

    def mark_instance_terminal_observed(self, machine_id: str, instance_id: str) -> Machine:
        cursor = self._connection.execute(
            """
            UPDATE machines SET instance_terminal_observed = 1, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND instance_id = ?
            """,
            (machine_id, instance_id),
        )
        current = self.get(machine_id)
        if cursor.rowcount != 1 and current.instance_id != instance_id:
            raise StoreError("terminal observation does not match recorded instance")
        return current

    def set_observed(
        self, claim: Machine, observed: ObservedState, error: str | None = None
    ) -> Machine:
        self._connection.execute(
            """
            UPDATE machines
            SET observed_state = ?, observed_revision = ?, observed_operation_id = ?,
                error = ?, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND desired_revision = ? AND operation_id = ?
            """,
            (
                observed.value,
                claim.desired_revision,
                claim.operation_id,
                error,
                claim.machine_id,
                claim.desired_revision,
                claim.operation_id,
            ),
        )
        return self.get(claim.machine_id)

    def require_bundle(self, machine_id: str, revision: int, token: str) -> Machine:
        """Require the bundle of `revision` before the machine may launch or start.

        A revision older than the one already required leaves the machine unchanged.
        """
        self._connection.execute(
            """
            UPDATE machines SET required_bundle_revision = ?, required_bundle_token = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ?
            AND (required_bundle_revision IS NULL OR required_bundle_revision <= ?)
            """,
            (revision, token, machine_id, revision),
        )
        return self.get(machine_id)

    def record_bundle(self, machine_id: str, token: str) -> Machine:
        self._connection.execute(
            """
            UPDATE machines SET bundle_token = ?, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND required_bundle_token = ?
            """,
            (token, machine_id, token),
        )
        return self.get(machine_id)

    def intend_grant(
        self, slot_id: str, generation: int, key_arn: str, grantee_arn: str
    ) -> GrantRecord:
        """Record that a grant for this slot generation is about to be created.

        A retired grant (a retained machine that runs again) is reopened empty,
        since its revoked grant cannot be used again.
        """
        self._connection.execute(
            """
            INSERT INTO kms_grants (slot_id, generation, key_arn, grantee_arn)
            VALUES (?, ?, ?, ?) ON CONFLICT (slot_id, generation) DO UPDATE SET
                key_arn = excluded.key_arn, grantee_arn = excluded.grantee_arn,
                grant_id = NULL, grant_token = NULL, retired = 0, updated_at = CURRENT_TIMESTAMP
            WHERE kms_grants.retired = 1
            """,
            (slot_id, generation, key_arn, grantee_arn),
        )
        record = self.grant(slot_id, generation)
        if record is None:
            raise StoreError("grant intent was not recorded")
        if record.key_arn != key_arn or record.grantee_arn != grantee_arn:
            raise StoreError("the grant of this slot generation has a different key or grantee")
        return record

    def record_grant(
        self, slot_id: str, generation: int, grant_id: str, grant_token: str
    ) -> GrantRecord:
        cursor = self._connection.execute(
            """
            UPDATE kms_grants SET grant_id = ?, grant_token = ?, updated_at = CURRENT_TIMESTAMP
            WHERE slot_id = ? AND generation = ? AND retired = 0
            """,
            (grant_id, grant_token, slot_id, generation),
        )
        if cursor.rowcount != 1:
            raise StoreError("no open grant intent for this slot generation")
        record = self.grant(slot_id, generation)
        assert record is not None
        return record

    def grant(self, slot_id: str, generation: int) -> GrantRecord | None:
        row = self._connection.execute(
            "SELECT * FROM kms_grants WHERE slot_id = ? AND generation = ?",
            (slot_id, generation),
        ).fetchone()
        return None if row is None else _grant(row)

    def open_grants(self, slot_id: str, before_generation: int) -> list[GrantRecord]:
        return [
            _grant(row)
            for row in self._connection.execute(
                """
                SELECT * FROM kms_grants WHERE slot_id = ? AND generation < ? AND retired = 0
                ORDER BY generation
                """,
                (slot_id, before_generation),
            )
        ]

    def mark_grant_retired(self, slot_id: str, generation: int) -> None:
        self._connection.execute(
            """
            UPDATE kms_grants SET retired = 1, updated_at = CURRENT_TIMESTAMP
            WHERE slot_id = ? AND generation = ?
            """,
            (slot_id, generation),
        )

    def get(self, machine_id: str) -> Machine:
        return self._get_row(machine_id)

    def find(self, slot_id: str, generation: int) -> Machine | None:
        row = self._connection.execute(
            "SELECT * FROM machines WHERE slot_id = ? AND generation = ?", (slot_id, generation)
        ).fetchone()
        return None if row is None else _machine(row)

    def latest(self, slot_id: str) -> Machine:
        row = self._connection.execute(
            "SELECT * FROM machines WHERE slot_id = ? ORDER BY generation DESC LIMIT 1",
            (slot_id,),
        ).fetchone()
        if row is None:
            raise MachineNotFoundError(f"no machine for slot {slot_id!r}")
        return _machine(row)

    def list(self) -> list[Machine]:
        return [
            _machine(row)
            for row in self._connection.execute(
                "SELECT * FROM machines ORDER BY slot_id, generation"
            )
        ]

    def _get_row(self, machine_id: str) -> Machine:
        row = self._connection.execute(
            "SELECT * FROM machines WHERE machine_id = ?", (machine_id,)
        ).fetchone()
        if row is None:
            raise MachineNotFoundError(f"unknown machine {machine_id!r}")
        return _machine(row)

    def _mark_intent(self, claim: Machine, column: str) -> Machine:
        if column not in {
            "volume_create_intent",
            "volume_create_issued",
            "instance_launch_intent",
            "instance_terminate_issued",
            "volume_delete_issued",
        }:
            raise ValueError("invalid intent column")
        return self._cas_update(claim, f"{column} = 1")

    def _cas_update(self, claim: Machine, assignment: str) -> Machine:
        self._connection.execute(
            f"""
            UPDATE machines SET {assignment}, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND desired_revision = ? AND operation_id = ?
            """,
            (claim.machine_id, claim.desired_revision, claim.operation_id),
        )
        return self.get(claim.machine_id)

    def _set_once(
        self, machine_id: str, column: str, value: str, extra: tuple[str, str] | None = None
    ) -> None:
        if column not in {"instance_id", "data_volume_id"}:
            raise ValueError("invalid set-once column")
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            current = self._get_row(machine_id)
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
            values.append(machine_id)
            self._connection.execute(
                f"UPDATE machines SET {', '.join(assignments)} WHERE machine_id = ?", values
            )
            self._connection.execute("COMMIT")
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise


def require_recovery_allowed(machine: Machine) -> None:
    if machine.recovery_count >= RECOVERY_LIMIT:
        raise StoreError("automatic machine recovery limit reached; operator review is required")


def _later(stored: datetime | None, requested: datetime | None) -> datetime | None:
    if stored is None:
        return requested
    if requested is None:
        return stored
    return max(stored, requested)


def _timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        raise StoreError("retain_until must carry a time zone")
    return value.astimezone(UTC).isoformat()


def _machine(row: sqlite3.Row) -> Machine:
    return Machine(
        machine_id=row["machine_id"],
        slot_id=row["slot_id"],
        generation=row["generation"],
        desired_state=DesiredState(row["desired_state"]),
        desired_revision=row["desired_revision"],
        operation_id=row["operation_id"],
        core_revision=row["core_revision"],
        retain_until=(datetime.fromisoformat(row["retain_until"]) if row["retain_until"] else None),
        instance_type=row["instance_type"],
        image_id=row["image_id"],
        assignment_secret_arn=row["assignment_secret_arn"],
        instance_profile_arn=row["instance_profile_arn"],
        instance_id=row["instance_id"],
        previous_instance_id=row["previous_instance_id"],
        previous_runtime_fingerprint=row["previous_runtime_fingerprint"],
        instance_seq=row["instance_seq"],
        recovery_count=row["recovery_count"],
        data_volume_id=row["data_volume_id"],
        volume_az=row["volume_az"],
        observed_state=ObservedState(row["observed_state"]),
        observed_revision=row["observed_revision"],
        observed_operation_id=row["observed_operation_id"],
        error=row["error"],
        volume_create_intent=bool(row["volume_create_intent"]),
        volume_create_issued=bool(row["volume_create_issued"]),
        instance_launch_intent=bool(row["instance_launch_intent"]),
        instance_launch_issued=bool(row["instance_launch_issued"]),
        instance_launch_issued_at=(
            datetime.fromisoformat(row["instance_launch_issued_at"])
            if row["instance_launch_issued_at"]
            else None
        ),
        instance_terminate_issued=bool(row["instance_terminate_issued"]),
        instance_terminal_observed=bool(row["instance_terminal_observed"]),
        volume_delete_issued=bool(row["volume_delete_issued"]),
        required_bundle_revision=row["required_bundle_revision"],
        required_bundle_token=row["required_bundle_token"],
        bundle_token=row["bundle_token"],
        target_image_id=row["target_image_id"],
    )


def _grant(row: sqlite3.Row) -> GrantRecord:
    return GrantRecord(
        slot_id=row["slot_id"],
        generation=row["generation"],
        key_arn=row["key_arn"],
        grantee_arn=row["grantee_arn"],
        grant_id=row["grant_id"],
        grant_token=row["grant_token"],
        retired=bool(row["retired"]),
    )
