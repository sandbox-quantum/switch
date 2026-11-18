"""Which machine and OS account a controller runs on, as Switch keeps it.

A controller derives a device id from its machine's own id and the OS account
it runs as (`device-id.ts` in `@switch-console/agent-controller`): a SHA-256,
the same each time it is read on that machine and account, and different on
any other. It sends it when it enrolls and with every status report.

Switch stores `device_hash(owner_id, device_id)` rather than the id itself, so
the column cannot link two people's controllers to one machine: the same
computer used by two people reads as two unrelated values.
"""

from __future__ import annotations

import hashlib
import re

DEVICE_ID_PATTERN = r"^[0-9a-f]{64}$"
_DEVICE_ID = re.compile(DEVICE_ID_PATTERN)


def is_device_id(value: str) -> bool:
    """Whether `value` has the shape a controller's device id has."""
    return _DEVICE_ID.fullmatch(value) is not None


def device_hash(owner_id: str, device_id: str) -> str:
    """What Switch keeps of `device_id` for a controller `owner_id` owns."""
    return hashlib.sha256(f"{owner_id}\n{device_id}".encode()).hexdigest()
