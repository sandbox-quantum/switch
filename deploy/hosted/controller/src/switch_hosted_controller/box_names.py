"""Box namespace names: the one place their patterns live.

Two shapes, both fixed when the namespace is made and never changed:

- `agents-user-k1-<16 hex>`: named after the person (their keyed id). Every box made before the warm pool.
- `agents-box-k1-<16 hex>`: named after the box (its keyed id, which Core derives from the machine id). Every box
  made by an operator that lists `box_keyed_names`, pool boxes included. The person it belongs to is in the
  append-only `box-owners` map, never in its name.

Each box's identity is its name minus `agents-` (`user-k1-…` or `box-k1-…`). It's the hostname, and the value of
the box's one name label: `switch.dev/user` for the first shape, `switch.dev/box` for the second. The admission
policy (P1) checks the same thing.

Every module that checks a box namespace imports its pattern from here (`test_box_names.py` fails on a pattern
compiled anywhere else):

- `BOX_NAMESPACE_RE`: exact, both shapes. Anything the operator makes or names.
- `KNOWN_BOX_NAMESPACE_RE`: what the readers (the scaler, placer, drain, restart, egress lists) accept from the
  box map. The exact box-keyed shape, or a person-keyed name as loosely as they accepted it before. A box map is
  refused whole if any entry is off, so a hand-rendered name from before the operator must not stop every box.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

KEYED_ID = r"k1-[0-9a-f]{16}"
KEYED_ID_RE = re.compile(KEYED_ID)
USER_PREFIX, BOX_PREFIX = "agents-user-", "agents-box-"
USER_LABEL, BOX_LABEL = "switch.dev/user", "switch.dev/box"

USER_NAMESPACE_RE = re.compile(rf"agents-user-{KEYED_ID}")
BOX_KEYED_NAMESPACE_RE = re.compile(rf"agents-box-{KEYED_ID}")
BOX_NAMESPACE_RE = re.compile(rf"agents-(?:user|box)-{KEYED_ID}")
KNOWN_BOX_NAMESPACE_RE = re.compile(rf"agents-user-[a-z0-9-]+|agents-box-{KEYED_ID}")


def user_namespace(user_keyed_id: str) -> str:
    """The person-keyed name, for a box that had one before."""
    if not KEYED_ID_RE.fullmatch(user_keyed_id):
        raise ValueError("not a keyed id")
    return USER_PREFIX + user_keyed_id


def box_namespace(box_keyed_id: str) -> str:
    """The box-keyed name of a new box."""
    if not KEYED_ID_RE.fullmatch(box_keyed_id):
        raise ValueError("not a keyed id")
    return BOX_PREFIX + box_keyed_id


def is_box_keyed(namespace: str) -> bool:
    return BOX_KEYED_NAMESPACE_RE.fullmatch(namespace) is not None


def identity(namespace: str) -> str:
    """`user-k1-…` or `box-k1-…`: the hostname and the name label's value. Exact names only."""
    if not BOX_NAMESPACE_RE.fullmatch(namespace):
        raise ValueError("not a box namespace")
    return namespace.removeprefix("agents-")


def name_label(namespace: str) -> tuple[str, str]:
    """The box's one name label, as P1 requires for its shape."""
    return (BOX_LABEL if is_box_keyed(namespace) else USER_LABEL), identity(namespace)


def is_legacy(namespace: str) -> bool:
    """A name only the readers' loose pattern accepts: from before the operator, kept working for now. The workers
    count these in their round line (`legacy_names=`), never naming one, so the allowance can be dropped once the
    count is zero everywhere."""
    return (
        KNOWN_BOX_NAMESPACE_RE.fullmatch(namespace) is not None
        and BOX_NAMESPACE_RE.fullmatch(namespace) is None
    )


# The add-only list of retired boxes, in `switch-hosted`: box namespace -> machine id. An entry means "this box is
# gone, or going": every reader of the box map drops it, the remover may delete it, and no box is ever made or adopted
# under it again. Only the provisioner adds to it, for a removal it claimed from Core.
REMOVALS_SECRET = "box-removals"


def live_boxes(box_map: Mapping[str, str], removals: Mapping[str, str]) -> dict[str, str]:
    """The box map without its retired boxes: machine id -> namespace, for every namespace not in `box-removals`."""
    return {machine: ns for machine, ns in box_map.items() if ns not in removals}
