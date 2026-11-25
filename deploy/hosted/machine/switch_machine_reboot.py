#!/usr/bin/env python3
"""Reboot a Switch Cloud machine whose pending reboot has waited too long.

Runs as root every hour (`switch-machine-reboot.timer`). unattended-upgrades
installs security updates every day, but a new kernel, and a new C library or
systemd, only take effect at a reboot. A machine that is never idle is never
stopped, so it would run its old kernel for as long as it stays busy. This
script gives every pending reboot a deadline: it reboots the machine in the
quiet hour once the reboot has been pending for REBOOT_AFTER, and at any hour
once it has been pending for REBOOT_DEADLINE.

A reboot ends every agent session on the machine. That is deliberate: a
security fix that waits for a quiet moment that never comes is no fix. The
machine keeps its instance, its root volume and its data volume, and the boot
service starts the controllers again.

A reboot is pending when /run/reboot-required exists (packages such as the
kernel, libc and systemd create it) or when the newest installed kernel is not
the one running. The time it was first seen pending is kept under /run, which
a reboot empties, so every reboot starts the count again.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

logger = logging.getLogger("switch-machine-reboot")

REBOOT_REQUIRED = Path("/run/reboot-required")
REBOOT_REQUIRED_PACKAGES = Path("/run/reboot-required.pkgs")
PENDING_SINCE = Path("/run/switch-machine-reboot/pending-since")
NEWEST_KERNEL = Path("/boot/vmlinuz")
KERNEL_PREFIX = "vmlinuz-"
# A pending reboot happens in the quiet hour once it has waited REBOOT_AFTER,
# so it falls on the last quiet hour before REBOOT_DEADLINE, and at any hour
# once it has waited REBOOT_DEADLINE (the machine was stopped through the
# quiet hour, say).
REBOOT_DEADLINE = timedelta(days=7)
REBOOT_AFTER = REBOOT_DEADLINE - timedelta(days=1)
# 07:00 UTC: night in the Americas, early morning in Europe.
QUIET_HOUR_UTC = 7


def kernel_pending() -> bool:
    """Whether the newest installed kernel (/boot/vmlinuz) is not the running one."""
    if not NEWEST_KERNEL.exists():
        return False
    newest = NEWEST_KERNEL.resolve().name
    if not newest.startswith(KERNEL_PREFIX):
        logger.warning("%s points at %s, not a kernel image", NEWEST_KERNEL, newest)
        return False
    return newest.removeprefix(KERNEL_PREFIX) != os.uname().release


def reboot_pending() -> bool:
    return REBOOT_REQUIRED.exists() or kernel_pending()


def pending_since(now: datetime) -> datetime:
    """When this boot first saw the reboot pending, recorded now if not yet."""
    try:
        return datetime.fromisoformat(PENDING_SINCE.read_text().strip())
    except FileNotFoundError:
        PENDING_SINCE.parent.mkdir(mode=0o700, exist_ok=True)
        PENDING_SINCE.write_text(now.isoformat() + "\n")
        return now


def reboot_due(since: datetime, now: datetime) -> bool:
    waited = now - since
    return waited >= REBOOT_DEADLINE or (
        waited >= REBOOT_AFTER and now.hour == QUIET_HOUR_UTC
    )


def packages() -> str:
    try:
        names = REBOOT_REQUIRED_PACKAGES.read_text().split()
    except FileNotFoundError:
        names = []
    return ", ".join(sorted(set(names))) or "a newer kernel"


def run(now: datetime) -> None:
    if not reboot_pending():
        PENDING_SINCE.unlink(missing_ok=True)
        return
    since = pending_since(now)
    if not reboot_due(since, now):
        logger.info(
            "A reboot for %s has been pending since %s; this machine reboots by %s.",
            packages(),
            since.isoformat(timespec="minutes"),
            (since + REBOOT_DEADLINE).isoformat(timespec="minutes"),
        )
        return
    logger.warning(
        "Rebooting for %s, pending since %s: every agent session on this machine ends.",
        packages(),
        since.isoformat(timespec="minutes"),
    )
    subprocess.run(["systemctl", "reboot"], check=True)


def main() -> int:
    logging.basicConfig(
        stream=sys.stdout, level=logging.INFO, format="%(levelname)s %(message)s"
    )
    run(datetime.now(UTC))
    return 0


if __name__ == "__main__":
    sys.exit(main())
