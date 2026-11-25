"""The timer that reboots a Switch Cloud machine for updates that need it."""

from __future__ import annotations

import importlib.util
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "switch_machine_reboot.py"
spec = importlib.util.spec_from_file_location("switch_machine_reboot", SCRIPT)
assert spec is not None and spec.loader is not None
reboot = importlib.util.module_from_spec(spec)
sys.modules["switch_machine_reboot"] = reboot
spec.loader.exec_module(reboot)

RUNNING = "6.14.0-1015-aws"
NEWER = "6.14.0-1017-aws"
# Outside the quiet hour.
MONDAY_NOON = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)


class Machine:
    def __init__(self, root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.root = root
        self.reboots = 0
        (root / "run").mkdir()
        (root / "boot").mkdir()
        monkeypatch.setattr(reboot, "REBOOT_REQUIRED", root / "run/reboot-required")
        monkeypatch.setattr(
            reboot, "REBOOT_REQUIRED_PACKAGES", root / "run/reboot-required.pkgs"
        )
        monkeypatch.setattr(
            reboot, "PENDING_SINCE", root / "run/switch-machine-reboot/pending-since"
        )
        monkeypatch.setattr(reboot, "NEWEST_KERNEL", root / "boot/vmlinuz")
        monkeypatch.setattr(
            reboot.os,
            "uname",
            lambda: os.uname_result(("Linux", "machine", RUNNING, "#1", "x86_64")),
        )
        monkeypatch.setattr(reboot.subprocess, "run", self.run)
        self.install_kernel(RUNNING)

    def run(self, command, check):
        assert command == ["systemctl", "reboot"] and check
        self.reboots += 1

    def install_kernel(self, release: str) -> None:
        (self.root / f"boot/vmlinuz-{release}").write_text("")
        link = self.root / "boot/vmlinuz"
        link.unlink(missing_ok=True)
        link.symlink_to(f"vmlinuz-{release}")

    def require_reboot(self, *packages: str) -> None:
        (self.root / "run/reboot-required").write_text(
            "*** System restart required ***\n"
        )
        (self.root / "run/reboot-required.pkgs").write_text(
            "".join(f"{name}\n" for name in packages)
        )

    def boot(self) -> None:
        for path in (self.root / "run").rglob("*"):
            if path.is_file():
                path.unlink()


@pytest.fixture
def machine(tmp_path, monkeypatch) -> Machine:
    return Machine(tmp_path, monkeypatch)


def test_nothing_pending_means_no_reboot(machine):
    reboot.run(MONDAY_NOON)
    assert machine.reboots == 0
    assert not reboot.PENDING_SINCE.exists()


def test_a_pending_reboot_waits_and_is_recorded_once(machine):
    machine.require_reboot("libc6")
    reboot.run(MONDAY_NOON)
    reboot.run(MONDAY_NOON + timedelta(days=2))
    assert machine.reboots == 0
    assert (
        datetime.fromisoformat(reboot.PENDING_SINCE.read_text().strip()) == MONDAY_NOON
    )


def test_a_newer_kernel_is_pending_without_the_reboot_required_file(machine):
    machine.install_kernel(NEWER)
    reboot.run(MONDAY_NOON)
    assert reboot.PENDING_SINCE.exists()


def test_the_reboot_comes_in_the_quiet_hour_before_the_deadline(machine):
    machine.require_reboot("linux-image-6.14.0-1017-aws")
    reboot.run(MONDAY_NOON)
    hour = MONDAY_NOON
    while hour < MONDAY_NOON + reboot.REBOOT_DEADLINE and machine.reboots == 0:
        hour += timedelta(hours=1)
        reboot.run(hour)
    assert machine.reboots == 1
    assert hour.hour == reboot.QUIET_HOUR_UTC
    assert (
        MONDAY_NOON + reboot.REBOOT_AFTER <= hour < MONDAY_NOON + reboot.REBOOT_DEADLINE
    )


def test_past_the_deadline_the_reboot_comes_at_any_hour(machine):
    machine.require_reboot("linux-image-6.14.0-1017-aws")
    reboot.run(MONDAY_NOON)
    reboot.run(MONDAY_NOON + reboot.REBOOT_DEADLINE + timedelta(hours=3))
    assert machine.reboots == 1


def test_the_quiet_hour_alone_does_not_reboot_a_fresh_update(machine):
    machine.require_reboot("libc6")
    quiet = MONDAY_NOON.replace(hour=reboot.QUIET_HOUR_UTC)
    reboot.run(quiet)
    reboot.run(quiet + timedelta(days=1))
    assert machine.reboots == 0


def test_a_reboot_starts_the_count_again(machine):
    machine.require_reboot("libc6")
    reboot.run(MONDAY_NOON)
    machine.boot()
    later = MONDAY_NOON + timedelta(days=5)
    machine.require_reboot("systemd")
    reboot.run(later)
    assert datetime.fromisoformat(reboot.PENDING_SINCE.read_text().strip()) == later


def test_a_cleared_requirement_forgets_when_it_was_seen(machine):
    machine.require_reboot("libc6")
    reboot.run(MONDAY_NOON)
    (machine.root / "run/reboot-required").unlink()
    reboot.run(MONDAY_NOON + timedelta(hours=1))
    assert not reboot.PENDING_SINCE.exists()
