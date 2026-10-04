"""The hook through which Core tells agent management a cloud machine changed.

With agent management on, every cloud agent is a managed agent placed on its
machine's agents controller, and its definition is derived from its cloud
launch. Core owns the launches; Management owns the definitions. Core never
imports Management, so Management registers a `HostedPlacement` at wiring
time and Core calls it:

- `machine_changed` after any commit that changed what runs on a machine
  (a launch created, registered, started, stopped, restarted, retried or
  removed): the same points that bump the machine's `agents_version`.
- `machine_seen` on every heartbeat of the machine's supervisor, with the
  `agents_version` it was read at. Management syncs only when that version
  is one it has not synced yet, so a sync that failed after its trigger's
  commit, or that a restart cut off, is caught up within a heartbeat.

With agent management off nothing is registered and both calls do nothing:
cloud machines run their agents from `/hosted/machines/{id}/agents` as
before.
"""

from __future__ import annotations

from typing import Protocol


class HostedPlacement(Protocol):
    async def machine_changed(self, tenant_id: str, machine_id: str) -> None: ...

    async def machine_seen(
        self, tenant_id: str, machine_id: str, agents_version: int
    ) -> None: ...
