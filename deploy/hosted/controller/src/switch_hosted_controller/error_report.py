"""What the reconciler tells Core about its own errors, as fixed words only.

Core's observation accepts two optional fields for this, with strict types:

- `cloud_errors`, a list of `{call, kind, count}`: the AWS calls that failed,
  by which call and what kind of error. Never AWS's own code or message.
- `reconciler_errors`: how many errors of each kind the reconciler hit.

Both count everything since the reconciler last told Core. They go out on the
next observation of any machine, and are taken off only once Core has
accepted it, so an observation that fails to post loses nothing and nothing
is counted twice.
"""

from __future__ import annotations

from collections import Counter
from typing import Literal

from botocore.exceptions import BotoCoreError, ClientError

from .cloud import CloudCapacityError, CloudResourceError
from .store import StoreError

CloudCall = Literal["launch", "start", "stop", "terminate", "volume", "describe", "other"]
CloudErrorKind = Literal["capacity", "throttled", "permission", "other"]
ErrorKind = Literal["cloud", "core_api", "state", "other"]

# The EC2 operations the reconciler calls, by the call Core counts them under.
OPERATION_CALLS: dict[str, CloudCall] = {
    "RunInstances": "launch",
    "StartInstances": "start",
    "StopInstances": "stop",
    "TerminateInstances": "terminate",
    "CreateVolume": "volume",
    "AttachVolume": "volume",
    "DeleteVolume": "volume",
    "ModifyInstanceAttribute": "volume",
    "DescribeInstances": "describe",
    "DescribeVolumes": "describe",
    "DescribeImages": "describe",
}

CAPACITY_CODES = frozenset(
    {
        "InsufficientInstanceCapacity",
        "InsufficientVolumeCapacity",
        "InstanceLimitExceeded",
        "VolumeLimitExceeded",
        "VcpuLimitExceeded",
        "MaxSpotInstanceCountExceeded",
        "InsufficientHostCapacity",
        "InsufficientReservedInstanceCapacity",
    }
)
THROTTLED_CODES = frozenset(
    {"RequestLimitExceeded", "Throttling", "ThrottlingException", "TooManyRequestsException"}
)
PERMISSION_CODES = frozenset(
    {
        "UnauthorizedOperation",
        "AccessDenied",
        "AccessDeniedException",
        "AuthFailure",
        "OptInRequired",
        "Blocked",
    }
)

# Core refuses a count above this; one past it would lose the whole report.
MAX_COUNT = 1_000_000


def cloud_error(error: BaseException) -> dict[str, str] | None:
    """`{call, kind}` for an AWS error, or None for any other error."""
    if isinstance(error, CloudCapacityError):
        # The installation's own machine limit, checked before a launch.
        return {"call": "launch", "kind": "capacity"}
    if not isinstance(error, ClientError):
        return None
    call: CloudCall = OPERATION_CALLS.get(error.operation_name, "other")
    code = error.response.get("Error", {}).get("Code", "")
    kind: CloudErrorKind = "other"
    if code in CAPACITY_CODES:
        kind = "capacity"
    elif code in THROTTLED_CODES:
        kind = "throttled"
    elif code in PERMISSION_CODES:
        kind = "permission"
    return {"call": call, "kind": kind}


def error_kind(error: BaseException) -> ErrorKind:
    """What an error was about: the cloud, Core's API, the controller's own
    state store, or anything else."""
    # Imported here: the gateway module imports this one.
    from .gateway import GatewayError

    if isinstance(error, (ClientError, BotoCoreError, CloudResourceError)):
        return "cloud"
    if isinstance(error, GatewayError):
        return "core_api"
    if isinstance(error, StoreError):
        return "state"
    return "other"


class ErrorReport:
    """The errors not yet told to Core: failed cloud calls by call and kind,
    and all errors by kind."""

    def __init__(self) -> None:
        self._cloud: Counter[tuple[str, str]] = Counter()
        self._counts: Counter[str] = Counter()

    def record(self, error: BaseException) -> None:
        kind = error_kind(error)
        self._counts[kind] = min(self._counts[kind] + 1, MAX_COUNT)
        if (found := cloud_error(error)) is not None:
            key = (found["call"], found["kind"])
            self._cloud[key] = min(self._cloud[key] + 1, MAX_COUNT)

    def fields(self) -> dict[str, object]:
        """The extra observation fields, left in place until `sent` says Core
        took them. Empty when there's nothing to tell."""
        fields: dict[str, object] = {}
        if cloud := [
            {"call": call, "kind": kind, "count": count}
            for (call, kind), count in sorted(self._cloud.items())
            if count
        ]:
            fields["cloud_errors"] = cloud
        if counts := {kind: count for kind, count in sorted(self._counts.items()) if count}:
            fields["reconciler_errors"] = counts
        return fields

    def sent(self, fields: dict[str, object]) -> None:
        """Core took `fields`: take off what they carried, keeping anything
        recorded since."""
        cloud = fields.get("cloud_errors")
        if isinstance(cloud, list):
            for entry in cloud:
                key = (entry["call"], entry["kind"])
                self._cloud[key] = max(self._cloud[key] - entry["count"], 0)
        counts = fields.get("reconciler_errors")
        if isinstance(counts, dict):
            for kind, count in counts.items():
                self._counts[kind] = max(self._counts[kind] - count, 0)
