"""Reason codes carried in error envelopes, status reports and placement refusals.

The codes from the controller contract (§9), plus the few v1 adds for its own
routes. `no_stream` and `managed_by_controller` are also answered by Core's
bearer middleware and controller stream, which name the same strings without
importing this module. A code is part of the wire contract: a controller acts on it, so it
is never renamed.
"""

from __future__ import annotations

PROTOCOL_UNSUPPORTED = "protocol_unsupported"
TOKEN_EXPIRED = "token_expired"
CONTROLLER_REVOKED = "controller_revoked"
NOT_ASSIGNED = "not_assigned"
TAKEN_OVER = "taken_over"
STALE_GENERATION = "stale_generation"
UNKNOWN_CONNECTION = "unknown_connection"
NO_STREAM = "no_stream"
MANAGED_BY_CONTROLLER = "managed_by_controller"
ALREADY_CLAIMED = "already_claimed"
CANCELLED = "cancelled"
LEASE_EXPIRED = "lease_expired"
PROVIDER_NOT_INSTALLED = "provider_not_installed"
PROVIDER_VERSION_UNSUPPORTED = "provider_version_unsupported"
PROVIDER_LOGIN_MISSING = "provider_login_missing"
PROVIDER_LOGIN_EXPIRED = "provider_login_expired"
CONNECTOR_NOT_CONNECTED = "connector_not_connected"
CONNECTOR_REVOKED = "connector_revoked"
DEFINITION_INVALID = "definition_invalid"
REPO_CLONE_FAILED = "repo_clone_failed"
CRASH_LOOP = "crash_loop"
OUT_OF_MEMORY = "out_of_memory"
DISK_FULL = "disk_full"
CAPACITY_EXCEEDED = "capacity_exceeded"
CONTROLLER_OFFLINE = "controller_offline"
INTERNAL = "internal"

FORBIDDEN = "forbidden"
INVALID_CREDENTIAL = "invalid_credential"
ENROLLMENT_CODE_INVALID = "enrollment_code_invalid"
OPERATION_UNSUPPORTED = "operation_unsupported"
NOT_FOUND = "not_found"
VALIDATION_ERROR = "validation_error"
INSTANCE_MISMATCH = "instance_mismatch"
RELAY_RESOLVED = "relay_resolved"

ALL_REASON_CODES = frozenset(
    {
        PROTOCOL_UNSUPPORTED,
        TOKEN_EXPIRED,
        CONTROLLER_REVOKED,
        NOT_ASSIGNED,
        TAKEN_OVER,
        STALE_GENERATION,
        UNKNOWN_CONNECTION,
        NO_STREAM,
        MANAGED_BY_CONTROLLER,
        ALREADY_CLAIMED,
        CANCELLED,
        LEASE_EXPIRED,
        PROVIDER_NOT_INSTALLED,
        PROVIDER_VERSION_UNSUPPORTED,
        PROVIDER_LOGIN_MISSING,
        PROVIDER_LOGIN_EXPIRED,
        CONNECTOR_NOT_CONNECTED,
        CONNECTOR_REVOKED,
        DEFINITION_INVALID,
        REPO_CLONE_FAILED,
        CRASH_LOOP,
        OUT_OF_MEMORY,
        DISK_FULL,
        CAPACITY_EXCEEDED,
        CONTROLLER_OFFLINE,
        INTERNAL,
        FORBIDDEN,
        INVALID_CREDENTIAL,
        ENROLLMENT_CODE_INVALID,
        OPERATION_UNSUPPORTED,
        NOT_FOUND,
        VALIDATION_ERROR,
        INSTANCE_MISMATCH,
        RELAY_RESOLVED,
    }
)
