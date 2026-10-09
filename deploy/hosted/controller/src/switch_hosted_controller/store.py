from __future__ import annotations

import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path

from .model import DesiredState, Machine, ObservedState

LEGACY_ROWS_MESSAGE = (
    "legacy per-agent rows present; see 'Moving to one machine per user' in deploy/hosted/README.md"
)
SLOT_ROWS_MESSAGE = (
    "the state database holds machines placed on slots that are not deleted; "
    "see 'Moving off machine slots' in deploy/hosted/README.md"
)


RECOVERY_LIMIT = 3


class StoreError(RuntimeError):
    pass


class CapacityError(StoreError):
    pass


class MachineNotFoundError(StoreError):
    pass


class MachineStore:
    def __init__(self, path: Path, controller_fingerprint: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(path, timeout=30, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._refuse_legacy_rows()
        self._drop_slot_rows()
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS machines (
                machine_id TEXT PRIMARY KEY,
                desired_state TEXT NOT NULL
                    CHECK (desired_state IN ('running', 'stopped', 'retained', 'deleted')),
                observed_state TEXT NOT NULL,
                core_revision INTEGER NOT NULL CHECK (core_revision >= 0),
                desired_revision INTEGER NOT NULL CHECK (desired_revision > 0),
                operation_id TEXT NOT NULL,
                instance_type TEXT NOT NULL,
                image_id TEXT NOT NULL,
                instance_seq INTEGER NOT NULL DEFAULT 0,
                recovery_count INTEGER NOT NULL DEFAULT 0,
                data_volume_id TEXT,
                volume_az TEXT,
                instance_id TEXT,
                previous_instance_id TEXT,
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
                bundle TEXT,
                instance_bundle TEXT,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS controller_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        self._keep_instance_bundles()
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

    def _drop_slot_rows(self) -> None:
        """Forget the machines of a database from before machine slots were removed.

        Only ones observed deleted are forgotten: a machine still on a slot
        boots from that slot's secret, which no longer exists.
        """
        columns = {row["name"] for row in self._connection.execute("PRAGMA table_info(machines)")}
        if "slot_id" not in columns:
            return
        live = self._connection.execute(
            "SELECT COUNT(*) FROM machines WHERE observed_state <> 'deleted'"
        ).fetchone()[0]
        if live:
            self._connection.close()
            raise StoreError(SLOT_ROWS_MESSAGE)
        self._connection.executescript(
            """
            BEGIN IMMEDIATE;
            DROP INDEX IF EXISTS machines_one_live_row_per_slot;
            DROP TABLE machines;
            COMMIT;
            """
        )

    def _keep_instance_bundles(self) -> None:
        """Move a database that kept only the token of an instance's bundle to
        keeping the bundle itself; one no longer current is not known."""
        columns = {row["name"] for row in self._connection.execute("PRAGMA table_info(machines)")}
        if "instance_bundle_token" not in columns:
            return
        self._connection.executescript(
            """
            BEGIN IMMEDIATE;
            ALTER TABLE machines ADD COLUMN instance_bundle TEXT;
            UPDATE machines SET instance_bundle = bundle
                WHERE instance_bundle_token IS NOT NULL AND instance_bundle_token = bundle_token;
            ALTER TABLE machines DROP COLUMN instance_bundle_token;
            COMMIT;
            """
        )

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
        core_revision: int,
        instance_type: str,
        image_id: str,
        max_machines: int,
    ) -> Machine:
        """Insert a machine, within the configured capacity."""
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            if self._connection.execute(
                "SELECT 1 FROM machines WHERE machine_id = ?", (machine_id,)
            ).fetchone():
                raise StoreError(f"machine {machine_id!r} already exists")
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
                    machine_id, desired_state, observed_state, core_revision,
                    desired_revision, operation_id, instance_type, image_id,
                    observed_revision, observed_operation_id
                ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, ?)
                """,
                (
                    machine_id,
                    DesiredState.RUNNING.value,
                    ObservedState.PENDING.value,
                    core_revision,
                    operation_id,
                    instance_type,
                    image_id,
                    operation_id,
                ),
            )
            self._connection.execute("COMMIT")
            return self.get(machine_id)
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

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

    def upgrade_terminated(self, claim: Machine, image_id: str) -> Machine:
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
            instance_bundle = NULL,
            image_id = ?, instance_seq = instance_seq + 1,
            desired_revision = desired_revision + 1, operation_id = ?,
            instance_launch_intent = 0, instance_launch_issued = 0, instance_launch_issued_at = NULL,
            instance_terminate_issued = 0,
            instance_terminal_observed = 0, observed_state = 'stopped', error = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND desired_revision = ? AND operation_id = ?
            AND desired_state = 'stopped' AND instance_id = ? AND instance_terminal_observed = 1""",
            (
                image_id,
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
            instance_bundle = NULL,
            instance_seq = instance_seq + 1,
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

    def release_terminated(self, claim: Machine) -> Machine:
        """Forget a retained machine's terminated instance so a later start launches a new one."""
        if not claim.instance_terminal_observed or not claim.instance_id:
            raise StoreError("release requires a confirmed terminated instance")
        self._connection.execute(
            """UPDATE machines SET previous_instance_id = instance_id, instance_id = NULL,
            instance_bundle = NULL,
            instance_seq = instance_seq + 1,
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

    def record_instance(self, machine_id: str, instance_id: str, bundle: str | None) -> Machine:
        """Record the machine's instance, launched with `bundle` as its user data,
        or None when that is not known."""
        self._set_once(machine_id, "instance_id", instance_id, extra=("instance_bundle", bundle))
        return self.get(machine_id)

    def record_instance_bundle(self, machine_id: str, instance_id: str, bundle: str) -> Machine:
        """Record that the instance now boots from `bundle`."""
        self._connection.execute(
            """
            UPDATE machines SET instance_bundle = ?, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND instance_id = ?
            """,
            (bundle, machine_id, instance_id),
        )
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

    def record_bundle(self, machine_id: str, token: str, bundle: str) -> Machine:
        """Keep the bundle of the required revision, which the machine's next
        instance launch or start boots from."""
        self._connection.execute(
            """
            UPDATE machines SET bundle_token = ?, bundle = ?, updated_at = CURRENT_TIMESTAMP
            WHERE machine_id = ? AND required_bundle_token = ?
            """,
            (token, bundle, machine_id, token),
        )
        return self.get(machine_id)

    def get(self, machine_id: str) -> Machine:
        return self._get_row(machine_id)

    def find(self, machine_id: str) -> Machine | None:
        row = self._connection.execute(
            "SELECT * FROM machines WHERE machine_id = ?", (machine_id,)
        ).fetchone()
        return None if row is None else _machine(row)

    def list(self) -> list[Machine]:
        return [
            _machine(row)
            for row in self._connection.execute(
                "SELECT * FROM machines ORDER BY created_at, machine_id"
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
        self,
        machine_id: str,
        column: str,
        value: str,
        extra: tuple[str, str | None] | None = None,
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
            values: list[str | None] = [value]
            if extra is not None:
                extra_column, extra_value = extra
                if extra_column not in {"volume_az", "instance_bundle"}:
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
        raise StoreError("automatic worker recovery limit reached; operator review is required")


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
        desired_state=DesiredState(row["desired_state"]),
        desired_revision=row["desired_revision"],
        operation_id=row["operation_id"],
        core_revision=row["core_revision"],
        retain_until=(datetime.fromisoformat(row["retain_until"]) if row["retain_until"] else None),
        instance_type=row["instance_type"],
        image_id=row["image_id"],
        instance_id=row["instance_id"],
        previous_instance_id=row["previous_instance_id"],
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
        bundle=row["bundle"],
        instance_bundle=row["instance_bundle"],
    )
