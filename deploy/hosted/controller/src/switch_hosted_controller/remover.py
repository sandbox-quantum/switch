"""`switch-hosted-remover`: deletes retired box namespaces, and nothing else (automated box removal).

A person's deleted box is named for removal by Core. The box operator claims it and lists its namespace in the
add-only `box-removals` (namespace to machine id), which retires it everywhere. The remover is the only program that
deletes a person's box, on its own account and its own Core credential (`remover_token`), and it never decides:

- It acts only on `box-removals`, which it can't write.
- Before each delete it checks on the cluster that the namespace's `machine-id` annotation is the entry's machine, so
  a wrong entry can't delete another box; then it asks Core, on its own credential, whether that machine's removal is
  claimed, not cancelled, of a deleted machine, under this namespace (`removable`). Anything else: skipped, alerted.
- It deletes the namespace (its only write right). The disks go with their claims (`reclaimPolicy: Delete`). The
  operator confirms to Core once nothing is left.
- Every pass it reports the entries it read, so Core alerts on any it doesn't back.

The cluster's admission policy lets this account delete only a namespace listed in `box-removals`. Logs carry
namespaces, machine ids and fixed words only.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, Protocol
from uuid import UUID

from .box_names import BOX_NAMESPACE_RE

logger = logging.getLogger(__name__)

PASS_INTERVAL_S = 30.0
MACHINE_ANNOTATION = "switch.dev/machine-id"


class RemoverCore(Protocol):
    def removable(self, machine_id: str, namespace: str) -> bool: ...
    def listed(self, entries: list[dict[str, str]]) -> None: ...


class RemoverKube(Protocol):
    def removals(self) -> Mapping[str, str]: ...  # `box-removals`: namespace -> machine id
    def get_namespace(self, name: str) -> dict[str, Any] | None: ...
    def delete_namespace(self, name: str) -> None: ...


def _machine(value: str) -> str | None:
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        return None


def remove_once(core: RemoverCore, kube: RemoverKube) -> dict[str, int]:
    """One pass over `box-removals`. Returns counts: deleted, gone (nothing left to do), waiting (deleting already),
    refused (never deleted: a bad entry, another machine's namespace, or Core said no), failed (tried next pass).

    A list that can't be read raises: nothing is deleted on a list this couldn't read."""
    counts = {"deleted": 0, "gone": 0, "waiting": 0, "refused": 0, "failed": 0}
    removals = dict(kube.removals())
    entries = [{"namespace": ns, "machine_id": m} for ns, m in sorted(removals.items())]
    if entries:
        try:
            core.listed(entries)
        except (
            Exception
        ) as exc:  # Core's audit of the list is its own; deleting goes on under its own check
            logger.warning("Removals not reported to Core this pass (%s).", type(exc).__name__)
    for namespace, raw_machine in sorted(removals.items()):
        machine = _machine(raw_machine)
        if not BOX_NAMESPACE_RE.fullmatch(namespace) or machine is None:
            counts["refused"] += 1
            logger.error("Remover ALERT: a box-removals entry is out of form; not deleted.")
            continue
        try:
            existing = kube.get_namespace(namespace)
            if existing is None:
                counts["gone"] += 1
                continue
            meta = existing.get("metadata") or {}
            if (meta.get("annotations") or {}).get(MACHINE_ANNOTATION) != machine:
                counts["refused"] += 1
                logger.error(
                    "Remover ALERT: %s belongs to another machine than its box-removals entry; not deleted.",
                    namespace,
                )
                continue
            if (
                meta.get("deletionTimestamp")
                or (existing.get("status") or {}).get("phase") == "Terminating"
            ):
                counts["waiting"] += 1
                continue
            if not core.removable(machine, namespace):
                counts["refused"] += 1
                logger.error(
                    "Remover ALERT: Core does not back the removal of %s; not deleted.", namespace
                )
                continue
            kube.delete_namespace(namespace)
            counts["deleted"] += 1
            logger.info("Box %s: namespace deleted (machine %s).", namespace, machine)
        except Exception as exc:  # one box failing is that box's alone
            counts["failed"] += 1
            logger.warning("Box %s: not removed this pass (%s).", namespace, type(exc).__name__)
    return counts
