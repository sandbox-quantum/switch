"""The name a switch-core process goes by."""

from __future__ import annotations

import socket

from switch_core.process_identity import new_process_id


def test_the_pod_name_leads_the_id() -> None:
    assert new_process_id("switch-core-7d9f-x2k4").startswith("switch-core-7d9f-x2k4-")


def test_outside_kubernetes_the_host_name_stands_in() -> None:
    assert new_process_id(None).startswith(socket.gethostname() + "-")


def test_two_lives_of_one_pod_are_told_apart() -> None:
    """A pod restarted in place keeps its name; the lease and connections of
    the process before must not read as the process after's."""
    assert new_process_id("switch-core-0") != new_process_id("switch-core-0")
