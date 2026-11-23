"""`switch-hosted-reaper`: deletes unclaimed pool boxes, and nothing else (warm pool).

The operator only creates; the pool needs a box gone when it's retired (a new image, 24 hours old, the pool made
smaller, or a claim that failed before its owner was written). The reaper is its own program on its own account
and its own Core credential (`reaper_token`), which Core accepts only on its two routes:

- It acts only on Core's list of retiring pool boxes (`GET /hosted-provisioner/pool/retiring`). It never decides.
- For each, before deleting anything, it checks on the cluster that the namespace is an exact box-keyed name, is in
  `pool-map` under that pool box's id, and is in neither `box-map` nor `box-owners`: so nothing of a person's is
  ever deleted, even if Core asked. The cluster's admission policy checks the same, and is the last word.
- It deletes the namespace (its only write right). The disks go with their claims (`reclaimPolicy: Delete`).
- Only once the namespace is gone and no persistent volume still names it (read rights only) does it tell Core
  (`POST …/pool/{id}/gone`). A box still going is looked at again on the next pass.

Logs carry pool box ids, namespaces and fixed words only. The `stop_after` hook is for tests only.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any, Protocol

from .box_names import BOX_KEYED_NAMESPACE_RE

logger = logging.getLogger(__name__)

POOL_MAP_SECRET, BOX_MAP_SECRET, BOX_OWNERS_SECRET = "pool-map", "box-map", "box-owners"
PASS_INTERVAL_S = 30.0


class ReaperCore(Protocol):
    def retiring(self) -> list[dict[str, Any]]: ...
    def gone(self, pool_box_id: str) -> bool: ...  # False when Core refused it (409)


class ReaperKube(Protocol):
    def read_list(self, name: str) -> Mapping[str, str]: ...
    def namespace_exists(self, name: str) -> bool: ...
    def delete_namespace(self, name: str) -> None: ...
    def volumes_left(
        self, namespace: str
    ) -> int: ...  # persistent volumes whose claim was in `namespace`


def reapable(
    namespace: str,
    pool_box_id: str,
    pool_map: Mapping[str, str],
    box_map: Mapping[str, str],
    owners: Mapping[str, str],
) -> str | None:
    """Why this namespace must not be deleted, or None when it may: an exact box-keyed name, this pool box's own
    `pool-map` entry, and nothing of a person's (no `box-map` entry, no `box-owners` entry)."""
    if not BOX_KEYED_NAMESPACE_RE.fullmatch(namespace):
        return "not a box-keyed name"
    if pool_map.get(pool_box_id) != namespace:
        return "not this pool box's"
    if namespace in box_map.values():
        return "in the box map"
    if namespace in owners:
        return "has an owner"
    return None


def reap_once(
    core: ReaperCore,
    kube: ReaperKube,
    stop_after: Callable[[str], None] | None = None,
) -> dict[str, int]:
    """One pass over Core's retiring list. Returns counts: deleted, gone (reported), waiting, refused."""
    counts = {"deleted": 0, "gone": 0, "waiting": 0, "refused": 0}
    retiring = core.retiring()
    if not retiring:
        return counts
    pool_map = kube.read_list(POOL_MAP_SECRET)
    box_map = kube.read_list(BOX_MAP_SECRET)
    owners = kube.read_list(BOX_OWNERS_SECRET)
    for raw in retiring:
        pool_box_id, namespace = raw.get("pool_box_id"), raw.get("namespace")
        if not isinstance(pool_box_id, str) or not isinstance(namespace, str):
            counts["refused"] += 1
            continue
        why = reapable(namespace, pool_box_id, pool_map, box_map, owners)
        if why is not None:
            counts["refused"] += 1
            logger.error("Reaper ALERT: pool box %s not deleted (%s).", pool_box_id, why)
            continue
        try:
            if kube.namespace_exists(namespace):
                kube.delete_namespace(namespace)
                counts["deleted"] += 1
                logger.info("Pool box %s: namespace %s deleted.", pool_box_id, namespace)
                if stop_after is not None:
                    stop_after("deleted")
                continue  # it takes a while to go: reported on a later pass
            if kube.volumes_left(namespace):
                counts["waiting"] += 1
                continue
            if core.gone(pool_box_id):
                counts["gone"] += 1
                logger.info("Pool box %s: gone, told Core.", pool_box_id)
            else:
                counts["refused"] += 1
                logger.error("Reaper ALERT: Core refused pool box %s as gone.", pool_box_id)
        except Exception as exc:  # one box failing is that box's alone
            logger.warning(
                "Pool box %s: not reaped this pass (%s).", pool_box_id, type(exc).__name__
            )
    return counts
