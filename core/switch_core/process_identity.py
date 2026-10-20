"""The one name this switch-core process goes by.

Several processes can serve one database, and each writes things the others
read: a lease row in `switch_core_processes`, the controller connections it
holds, the signals it sends on `signals.SignalBus`. An operator reading any of
those, or a log line, or a metric series, needs to know which process it came
from, and needs the same answer from all of them. So the name is made once, at
startup, and handed to everything that records it.

It is the pod's name (POD_NAME, from the Kubernetes downward API) or the host
name, followed by a random suffix drawn at each start. The suffix is what keeps
two lives of one pod apart: a pod restarted in place keeps its name, and a
lease or a connection row left by the process before must never read as held
by the process after.
"""

from __future__ import annotations

import secrets
import socket


def new_process_id(pod_name: str | None) -> str:
    """A name for this process: its pod or host, then a suffix of its own."""
    return f"{pod_name or socket.gethostname()}-{secrets.token_hex(4)}"
