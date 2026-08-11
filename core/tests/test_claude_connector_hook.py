"""Tests for the Claude connector hook's credential resolution.

The hook authenticates to the agent bridge to mediate a session's tool calls, so
which agent it resolves has to be the same agent the Switch runtime bound. The
two are separate implementations in separate languages reading the same
directory, and they only stay in step deliberately — a divergence does not fail
anywhere, it just mediates the wrong agent, or stops mediating and says nothing.

The runtime's half of these cases lives in `bin.handshake.test.ts`; the shapes
asserted here are chosen to match it.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
HOOK_PATH = REPO_ROOT / "connectors/claude-code-plugin/hooks/switch_hook.py"

SWITCH_ENV_VARS = ("SWITCH_API_ENDPOINT", "SWITCH_API_TOKEN", "SWITCH_AGENT_ID")


def load_hook(
    monkeypatch: pytest.MonkeyPatch, project_dir: Path, **env: str
) -> ModuleType:
    """Import the hook fresh, with a chosen environment and project directory.

    The hook reads its environment at module scope, which is what a real
    invocation does — it is a short-lived process, spawned per event. So each
    case needs its own import rather than a shared module whose constants were
    fixed by whichever test ran first.
    """
    for name in SWITCH_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project_dir))

    spec = importlib.util.spec_from_file_location("switch_hook_under_test", HOOK_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered so dataclass/typing machinery in the module resolves normally;
    # removed again so the next case gets a clean import.
    sys.modules["switch_hook_under_test"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("switch_hook_under_test", None)
    return module


def provision(
    project_dir: Path,
    slug: str,
    *,
    agent_id: str,
    endpoint: str = "https://switch.example",
    token: str | None = "tok",
) -> None:
    """Write one store entry, in the shape Switch Console writes."""
    agents_dir = project_dir / ".switch" / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    env = {"SWITCH_API_ENDPOINT": endpoint, "SWITCH_AGENT_ID": agent_id}
    if token is not None:
        env["SWITCH_API_TOKEN"] = token
    (agents_dir / f"{slug}.json").write_text(json.dumps({"env": env}))


def test_complete_environment_wins_over_the_store(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Switch Console injects an identity per session; it outranks the disk."""
    provision(tmp_path, "solo", agent_id="uuid-solo", token="tok-store")
    hook = load_hook(
        monkeypatch,
        tmp_path,
        SWITCH_API_ENDPOINT="https://env.example",
        SWITCH_API_TOKEN="tok-env",
        SWITCH_AGENT_ID="uuid-env",
    )

    assert hook._credentials("uuid-env") == ("https://env.example", "tok-env")


def test_environment_without_an_agent_id_is_not_complete(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Must match the runtime, which requires all three before trusting the env.

    Short-circuiting on endpoint+token alone would mediate as whatever that token
    belongs to while the runtime refused the same environment outright.
    """
    provision(tmp_path, "solo", agent_id="uuid-solo", token="tok-store")
    hook = load_hook(
        monkeypatch,
        tmp_path,
        SWITCH_API_ENDPOINT="https://switch.example",
        SWITCH_API_TOKEN="tok-env",
    )

    # Falls through to the store and resolves the one agent actually there.
    assert hook._credentials("uuid-solo") == ("https://switch.example", "tok-store")


def test_single_store_entry_resolves_with_no_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The standalone case: a hand-started session with only the store."""
    provision(tmp_path, "solo", agent_id="uuid-solo", token="tok-store")
    hook = load_hook(monkeypatch, tmp_path)

    assert hook._configured() is True
    assert hook._credentials("") == ("https://switch.example", "tok-store")


def test_several_agents_resolve_by_the_id_the_session_bound(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    provision(tmp_path, "alice", agent_id="uuid-a", token="tok-a")
    provision(tmp_path, "bob", agent_id="uuid-b", token="tok-b")
    hook = load_hook(monkeypatch, tmp_path)

    assert hook._credentials("uuid-b") == ("https://switch.example", "tok-b")
    assert hook._credentials("uuid-a") == ("https://switch.example", "tok-a")


def test_several_agents_and_no_id_refuses(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Nothing names the agent, so any pick would be a guess at whose calls
    these are. The runtime leaves the identity unbound in the same situation."""
    provision(tmp_path, "alice", agent_id="uuid-a", token="tok-a")
    provision(tmp_path, "bob", agent_id="uuid-b", token="tok-b")
    hook = load_hook(monkeypatch, tmp_path)

    assert hook._credentials("") == ("", "")


def test_duplicate_agent_id_refuses(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Two files, one id, two tokens, nothing saying which is current.

    The runtime refuses this too. It used to take the first by filename, which
    left the session working while its mediation quietly stopped.
    """
    provision(tmp_path, "a-first", agent_id="uuid-dup", token="tok-a")
    provision(tmp_path, "b-second", agent_id="uuid-dup", token="tok-b")
    hook = load_hook(monkeypatch, tmp_path)

    assert hook._credentials("uuid-dup") == ("", "")


def test_unknown_agent_id_refuses(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    provision(tmp_path, "solo", agent_id="uuid-solo", token="tok-store")
    hook = load_hook(monkeypatch, tmp_path)

    assert hook._credentials("uuid-nobody") == ("", "")


def test_endpoint_in_the_environment_narrows_the_store(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    provision(
        tmp_path,
        "here",
        agent_id="uuid-here",
        endpoint="https://a.example",
        token="tok-a",
    )
    provision(
        tmp_path,
        "away",
        agent_id="uuid-away",
        endpoint="https://b.example",
        token="tok-b",
    )
    hook = load_hook(monkeypatch, tmp_path, SWITCH_API_ENDPOINT="https://a.example")

    assert hook._credentials("") == ("https://a.example", "tok-a")
    # The named agent belongs to the other server: refuse rather than cross it.
    assert hook._credentials("uuid-away") == ("", "")


def test_entries_missing_a_field_are_skipped_not_repaired(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A token-less entry is not a usable identity, and must not shadow one."""
    provision(tmp_path, "broken", agent_id="uuid-broken", token=None)
    provision(tmp_path, "solo", agent_id="uuid-solo", token="tok-store")
    hook = load_hook(monkeypatch, tmp_path)

    assert [a["agent_id"] for a in hook._read_agent_store()] == ["uuid-solo"]
    assert hook._credentials("") == ("https://switch.example", "tok-store")


def test_malformed_json_does_not_break_resolution(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    agents_dir = tmp_path / ".switch" / "agents"
    agents_dir.mkdir(parents=True)
    (agents_dir / "junk.json").write_text("{not json")
    provision(tmp_path, "solo", agent_id="uuid-solo", token="tok-store")
    hook = load_hook(monkeypatch, tmp_path)

    assert hook._credentials("") == ("https://switch.example", "tok-store")


def test_flat_field_names_are_accepted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The runtime accepts these too — they are the obvious hand-written shape."""
    agents_dir = tmp_path / ".switch" / "agents"
    agents_dir.mkdir(parents=True)
    (agents_dir / "flat.json").write_text(
        json.dumps(
            {
                "endpoint": "https://switch.example",
                "token": "tok-flat",
                "agent_id": "uuid-flat",
            }
        )
    )
    hook = load_hook(monkeypatch, tmp_path)

    assert hook._credentials("uuid-flat") == ("https://switch.example", "tok-flat")


def test_unconfigured_directory_is_an_ordinary_answer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A freshly installed plugin has no store and no environment; that is not an
    error, and the hook must not treat it as one."""
    hook = load_hook(monkeypatch, tmp_path)

    assert hook._read_agent_store() == []
    assert hook._configured() is False
