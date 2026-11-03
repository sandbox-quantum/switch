"""Who a Switch agent is to Switch Trust.

Switch Trust keys an agent by a fingerprint derived from where it lives: this
deployment, the tenant and the agent's id. Both the inventory sync
(`trust/inventory.py`) and every guardrail check (`trust/client.py`) need it,
and they have to agree byte for byte with Switch Trust's own derivation, or a
check lands on an agent the inventory never described. The sync compares the
fingerprints Switch Trust answers with against this function and fails when
they differ.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass


def agent_fingerprint(server_id: str, tenant_id: str, agent_id: str) -> str:
    """`agn_` and the first 128 bits of SHAKE-256 over the agent's resource
    name, hex-encoded."""
    resource = f"switch_rooms:{server_id}/{tenant_id}/{agent_id}"
    return "agn_" + hashlib.shake_256(resource.encode()).hexdigest(16)


def agent_label(name: str, display_name: str | None) -> str:
    """The name Switch Trust shows for an agent: the one people chose, else
    the identifier."""
    if display_name is not None and display_name.strip():
        return display_name.strip()
    return name


@dataclass(frozen=True)
class TrustAgent:
    """The Switch agent a checked message comes from."""

    tenant_id: str
    agent_id: str
    label: str
