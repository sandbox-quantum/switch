"""Files only Core may read, as a Kubernetes Secret volume mounts them."""

from __future__ import annotations

import os


def mounted_for_cores_group(st: os.stat_result) -> bool:
    """A Kubernetes Secret mounted with an `fsGroup`: owned by root and readable by that group alone, 0440 whatever
    the volume's defaultMode. Core runs as that group, and no other pod shares its volumes, so the file is Core's
    as much as a 0400 file of its own would be."""
    return (
        st.st_uid == 0
        and st.st_mode & 0o777 == 0o440
        and st.st_gid in {os.getgid(), *os.getgroups()}
    )
