import asyncio
import json
import os
import sys

import pytest

from switch_core.providers.claude_verifier import (
    ClaudeVerificationError,
    ClaudeVerifier,
)


def executable(tmp_path, body):
    path = tmp_path / "claude"
    path.write_text(f"#!{sys.executable}\n" + body)
    path.chmod(0o700)
    return str(path)


@pytest.mark.parametrize(
    "kind,variable",
    [("api-key", "ANTHROPIC_API_KEY"), ("setup-token", "CLAUDE_CODE_OAUTH_TOKEN")],
)
async def test_isolated_environment_and_disabled_tools(
    tmp_path, monkeypatch, kind, variable
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ambient-secret")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "ambient-secret")
    script = """import os, sys, json
assert os.environ[VARIABLE] == 'SYNTHETIC'
assert 'ambient-secret' not in os.environ.values()
assert sys.argv[sys.argv.index('--tools') + 1] == ''
assert '--no-session-persistence' in sys.argv
assert os.path.realpath(os.getcwd()) == os.path.realpath(os.environ['HOME'])
assert 'SYNTHETIC' not in sys.argv
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False}))
""".replace("VARIABLE", repr(variable))
    await ClaudeVerifier(executable(tmp_path, script)).verify(kind, "SYNTHETIC")


@pytest.mark.parametrize(
    "result", [{}, {"type": "result", "subtype": "error", "is_error": True}]
)
async def test_non_success_is_not_verified(tmp_path, result):
    verifier = ClaudeVerifier(executable(tmp_path, f"print({json.dumps(result)!r})"))
    with pytest.raises(ClaudeVerificationError):
        await verifier.verify("api-key", "SYNTHETIC")


async def test_raw_provider_output_is_not_exposed(tmp_path):
    verifier = ClaudeVerifier(executable(tmp_path, "print('PRIVATE-PROVIDER-OUTPUT')"))
    with pytest.raises(ClaudeVerificationError) as error:
        await verifier.verify("api-key", "SYNTHETIC")
    assert "PRIVATE" not in str(error.value)


async def test_cancellation_kills_process_and_cleans_home(tmp_path):
    marker = tmp_path / "process.json"
    script = f"import os, json, time\nopen({str(marker)!r}, 'w').write(json.dumps([os.getpid(), os.environ['HOME']]))\ntime.sleep(60)"
    task = asyncio.create_task(
        ClaudeVerifier(executable(tmp_path, script)).verify("api-key", "SYNTHETIC")
    )
    for _ in range(100):
        if marker.exists():
            break
        await asyncio.sleep(0.02)
    assert marker.exists()
    pid, home = json.loads(marker.read_text())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    assert not os.path.exists(home)
