from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class DesiredState(StrEnum):
    RUNNING = "running"
    STOPPED = "stopped"
    RETAINED = "retained"
    DELETED = "deleted"


class ObservedState(StrEnum):
    PENDING = "pending"
    PROVISIONING = "provisioning"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    RETAINED = "retained"
    DELETING = "deleting"
    DELETED = "deleted"
    NEEDS_ATTENTION = "needs_attention"


@dataclass(frozen=True)
class Machine:
    machine_id: str
    slot_id: str
    generation: int
    desired_state: DesiredState
    desired_revision: int
    operation_id: str
    core_revision: int
    retain_until: datetime | None
    instance_type: str
    image_id: str
    assignment_secret_arn: str
    instance_profile_arn: str
    instance_id: str | None
    previous_instance_id: str | None
    previous_runtime_fingerprint: str | None
    instance_seq: int
    recovery_count: int
    data_volume_id: str | None
    volume_az: str | None
    observed_state: ObservedState
    observed_revision: int
    observed_operation_id: str | None
    error: str | None
    volume_create_intent: bool
    volume_create_issued: bool
    instance_launch_intent: bool
    instance_launch_issued: bool
    instance_launch_issued_at: datetime | None
    instance_terminate_issued: bool
    instance_terminal_observed: bool
    volume_delete_issued: bool
    required_bundle_revision: int | None
    required_bundle_token: str | None
    bundle_token: str | None
