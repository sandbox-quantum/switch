from __future__ import annotations

import asyncio
import json
import os
import signal
import tempfile
from pathlib import Path


class ClaudeVerificationError(Exception):
    pass


class ClaudeVerifier:
    def __init__(self, executable: str):
        if not Path(executable).is_absolute() or not os.access(executable, os.X_OK):
            raise ValueError("Claude verification requires an absolute executable path")
        self.executable = executable
        self.slots = asyncio.Semaphore(2)

    async def verify(self, kind: str, credential: str) -> None:
        if self.slots.locked():
            raise ClaudeVerificationError(
                "Verification is busy. Please try again shortly."
            )
        async with self.slots:
            with tempfile.TemporaryDirectory(prefix="switch-claude-check-") as home:
                variable = (
                    "ANTHROPIC_API_KEY"
                    if kind == "api-key"
                    else "CLAUDE_CODE_OAUTH_TOKEN"
                )
                env = {
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "HOME": home,
                    "CLAUDE_CONFIG_DIR": home,
                    "DISABLE_TELEMETRY": "1",
                    "DISABLE_ERROR_REPORTING": "1",
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                    variable: credential,
                }
                try:
                    process = await asyncio.create_subprocess_exec(
                        self.executable,
                        "--print",
                        "Reply with OK.",
                        "--model",
                        "haiku",
                        "--output-format",
                        "json",
                        "--max-turns",
                        "1",
                        "--tools",
                        "",
                        "--setting-sources",
                        "",
                        "--strict-mcp-config",
                        "--mcp-config",
                        '{"mcpServers":{}}',
                        "--disable-slash-commands",
                        "--no-session-persistence",
                        cwd=home,
                        env=env,
                        start_new_session=True,
                        stdin=asyncio.subprocess.DEVNULL,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL,
                    )
                except OSError:
                    raise ClaudeVerificationError(
                        "Claude verification could not start. Contact your server administrator."
                    ) from None
                try:
                    output, _ = await asyncio.wait_for(
                        process.communicate(), timeout=25
                    )
                except TimeoutError:
                    raise ClaudeVerificationError(
                        "Claude verification timed out. Please try again."
                    ) from None
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    await process.wait()
                try:
                    result = json.loads(output)
                except (ValueError, UnicodeError):
                    raise ClaudeVerificationError(
                        "Claude did not return a verification result. Please try again."
                    ) from None
                if (
                    process.returncode != 0
                    or not isinstance(result, dict)
                    or result.get("type") != "result"
                    or result.get("subtype") != "success"
                    or result.get("is_error") is not False
                ):
                    raise ClaudeVerificationError(
                        "Claude could not complete the check. Check your credential, plan or API billing, then try again."
                    )
