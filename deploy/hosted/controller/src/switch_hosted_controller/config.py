from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SLOT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{2,39}$")
_INSTANCE_TYPE = re.compile(r"^[a-z0-9][a-z0-9.]{1,30}$")
_ARN = re.compile(r"^arn:(aws|aws-us-gov|aws-cn):[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:.+$")
_ROLE_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$"
)
_KMS_KEY_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):kms:([a-z]{2}(-gov)?-[a-z]+-\d):[0-9]{12}:key/[A-Za-z0-9-]{1,128}$"
)
_IMAGE_ID = re.compile(r"^ami-[0-9a-f]+$")


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class MachineSlot:
    instance_profile_arn: str
    assignment_secret_arn: str
    role_arn: str


@dataclass(frozen=True)
class ControllerConfig:
    installation_id: str
    region: str
    availability_zone: str
    subnet_id: str
    security_group_ids: tuple[str, ...]
    image_id: str
    root_device_name: str
    allowed_instance_types: frozenset[str]
    max_machines: int
    root_volume_gib: int
    data_volume_gib: int
    machine_slots: dict[str, MachineSlot]
    state_db_path: Path
    lock_path: Path
    poll_interval_seconds: float
    login_kms_key_arn: str

    @classmethod
    def load(cls, path: Path) -> ControllerConfig:
        try:
            raw = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise ConfigError(f"cannot load controller config {path}: {exc}") from exc
        if not isinstance(raw, dict):
            raise ConfigError("controller config must be a JSON object")
        return cls.from_dict(raw)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> ControllerConfig:
        required = {
            "installation_id",
            "region",
            "availability_zone",
            "subnet_id",
            "security_group_ids",
            "image_id",
            "root_device_name",
            "allowed_instance_types",
            "max_machines",
            "root_volume_gib",
            "data_volume_gib",
            "machine_slots",
            "state_db_path",
            "lock_path",
            "poll_interval_seconds",
            "login_kms_key_arn",
        }
        unknown = set(raw) - required
        missing = required - set(raw)
        if missing or unknown:
            raise ConfigError(
                f"config keys mismatch; missing={sorted(missing)}, unknown={sorted(unknown)}"
            )

        installation_id = _validated_string(raw, "installation_id", _ID)
        region = _validated_string(raw, "region", re.compile(r"^[a-z]{2}(-gov)?-[a-z]+-\d$"))
        availability_zone = _validated_string(
            raw, "availability_zone", re.compile(r"^[a-z]{2}(-gov)?-[a-z]+-\d[a-z]$")
        )
        if not availability_zone.startswith(region):
            raise ConfigError("availability_zone must belong to configured region")
        subnet_id = _validated_string(raw, "subnet_id", re.compile(r"^subnet-[0-9a-f]+$"))
        image_id = _validated_string(raw, "image_id", _IMAGE_ID)
        login_kms_key_arn = _validated_string(raw, "login_kms_key_arn", _KMS_KEY_ARN)
        key_match = _KMS_KEY_ARN.fullmatch(login_kms_key_arn)
        if key_match is None or key_match.group(2) != region:
            raise ConfigError("login_kms_key_arn must be a key in the configured region")
        root_device_name = _validated_string(
            raw, "root_device_name", re.compile(r"^/dev/[A-Za-z0-9._-]+$")
        )

        security_groups_raw = raw["security_group_ids"]
        if not isinstance(security_groups_raw, list) or not security_groups_raw:
            raise ConfigError("security_group_ids must be a non-empty list")
        security_group_ids = tuple(
            _validated_value(value, "security_group_ids entry", re.compile(r"^sg-[0-9a-f]+$"))
            for value in security_groups_raw
        )
        if len(set(security_group_ids)) != len(security_group_ids):
            raise ConfigError("security_group_ids must not contain duplicates")

        allowed_raw = raw["allowed_instance_types"]
        if not isinstance(allowed_raw, list) or not allowed_raw:
            raise ConfigError("allowed_instance_types must be a non-empty list")
        allowed_instance_types = frozenset(
            _validated_value(value, "allowed_instance_types entry", _INSTANCE_TYPE)
            for value in allowed_raw
        )

        max_machines = _bounded_int(raw, "max_machines", 1, 100)
        root_volume_gib = _bounded_int(raw, "root_volume_gib", 8, 1024)
        data_volume_gib = _bounded_int(raw, "data_volume_gib", 8, 16384)
        poll_interval = raw["poll_interval_seconds"]
        if not isinstance(poll_interval, (int, float)) or isinstance(poll_interval, bool):
            raise ConfigError("poll_interval_seconds must be a number")
        if not 0.2 <= float(poll_interval) <= 300:
            raise ConfigError("poll_interval_seconds must be between 0.2 and 300")

        slots_raw = raw["machine_slots"]
        if not isinstance(slots_raw, dict) or not slots_raw:
            raise ConfigError("machine_slots must be a non-empty object")
        slots: dict[str, MachineSlot] = {}
        for slot_id, slot_raw in slots_raw.items():
            _validated_value(slot_id, "machine_slots key", _SLOT_ID)
            slot_keys = {"instance_profile_arn", "assignment_secret_arn", "role_arn"}
            if not isinstance(slot_raw, dict) or set(slot_raw) != slot_keys:
                raise ConfigError(
                    f"machine slot {slot_id!r} must contain instance_profile_arn, assignment_secret_arn and role_arn"
                )
            profile = _validated_value(
                slot_raw["instance_profile_arn"], "instance_profile_arn", _ARN
            )
            secret = _validated_value(
                slot_raw["assignment_secret_arn"], "assignment_secret_arn", _ARN
            )
            if ":iam::" not in profile or ":instance-profile/" not in profile:
                raise ConfigError(f"machine slot {slot_id!r} has an invalid instance profile ARN")
            if ":secretsmanager:" not in secret or ":secret:" not in secret:
                raise ConfigError(f"machine slot {slot_id!r} has an invalid secret ARN")
            role = _validated_value(slot_raw["role_arn"], "role_arn", _ROLE_ARN)
            slots[slot_id] = MachineSlot(profile, secret, role)
        if len(slots) < max_machines:
            raise ConfigError("max_machines exceeds configured machine slots")
        profiles = [slot.instance_profile_arn for slot in slots.values()]
        secrets = [slot.assignment_secret_arn for slot in slots.values()]
        if len(set(profiles)) != len(profiles):
            raise ConfigError("machine slot instance profiles must be unique")
        if len(set(secrets)) != len(secrets):
            raise ConfigError("machine slot secrets must be unique")
        roles = [slot.role_arn for slot in slots.values()]
        if len(set(roles)) != len(roles):
            raise ConfigError("machine slot roles must be unique")

        state_db_path = _absolute_path(raw, "state_db_path")
        lock_path = _absolute_path(raw, "lock_path")
        if state_db_path == lock_path:
            raise ConfigError("state_db_path and lock_path must differ")

        return cls(
            installation_id=installation_id,
            region=region,
            availability_zone=availability_zone,
            subnet_id=subnet_id,
            security_group_ids=security_group_ids,
            image_id=image_id,
            root_device_name=root_device_name,
            allowed_instance_types=allowed_instance_types,
            max_machines=max_machines,
            root_volume_gib=root_volume_gib,
            data_volume_gib=data_volume_gib,
            machine_slots=slots,
            state_db_path=state_db_path,
            lock_path=lock_path,
            poll_interval_seconds=float(poll_interval),
            login_kms_key_arn=login_kms_key_arn,
        )

    def fingerprint(self) -> str:
        immutable = {
            "installation_id": self.installation_id,
            "region": self.region,
            "availability_zone": self.availability_zone,
            "subnet_id": self.subnet_id,
            "security_group_ids": sorted(self.security_group_ids),
            "root_device_name": self.root_device_name,
            "allowed_instance_types": sorted(self.allowed_instance_types),
            "root_volume_gib": self.root_volume_gib,
            "data_volume_gib": self.data_volume_gib,
        }
        payload = json.dumps(immutable, separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()

    def slot(self, slot_id: str) -> MachineSlot:
        try:
            return self.machine_slots[slot_id]
        except KeyError as exc:
            raise ConfigError(f"slot {slot_id!r} is not in machine_slots") from exc


def validate_slot_id(slot_id: str) -> str:
    return _validated_value(slot_id, "slot_id", _SLOT_ID)


def _validated_string(raw: dict[str, Any], key: str, pattern: re.Pattern[str]) -> str:
    return _validated_value(raw[key], key, pattern)


def _validated_value(value: Any, label: str, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ConfigError(f"{label} has an invalid value")
    return value


def _bounded_int(raw: dict[str, Any], key: str, minimum: int, maximum: int) -> int:
    value = raw[key]
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ConfigError(f"{key} must be an integer between {minimum} and {maximum}")
    return value


def _absolute_path(raw: dict[str, Any], key: str) -> Path:
    value = raw[key]
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ConfigError(f"{key} must be a non-empty path string")
    path = Path(value)
    if not path.is_absolute():
        raise ConfigError(f"{key} must be an absolute path")
    return path
