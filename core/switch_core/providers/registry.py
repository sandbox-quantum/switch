"""The agent CLIs Switch runs: one entry per provider, and the only list of them.

Everything else that depends on which providers exist — definition and launch
validation, the known-agent specs agents register through, advanced
configuration, provider credentials, the gateway's provider list — reads this
table through the functions below. Adding a provider is adding an entry; one
with no advanced settings, credentials or tools needs only an `id` and a
`label`.

Read the table through `agent_providers()` / `agent_provider()` rather than
importing `AGENT_PROVIDERS`, so every reader sees the same table.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from pydantic import AfterValidator

from switch_core.bridges.agent.protocol.types import ToolSpec
from switch_core.providers.advanced_fields import (
    CLAUDE_FIELDS,
    CODEX_FIELDS,
    OPENCODE_FIELDS,
    AdvancedField,
)


class UnknownProvider(ValueError):
    pass


@dataclass(frozen=True)
class TerminalStart:
    """The operator starts a session by running `command` in the agent's
    directory; `{prompt}` in it stands for the connect prompt."""

    command: str


@dataclass(frozen=True)
class ConsoleStart:
    """The operator starts a session from Switch Console. `runtime` names the
    runtime to enable in the agent's advanced settings there and
    `sign_in_command` the command that signs the CLI in; None when there is
    nothing to say."""

    runtime: str | None
    sign_in_command: str | None


@dataclass(frozen=True)
class AgentProvider:
    id: str
    """What a definition, a launch and a provider connection name it by."""

    label: str
    """How people see it named."""

    known_agent_type: str = ""
    """The known-agent spec its agents register through, stored on each agent
    as `known_agent_type`. Defaults to `id`."""

    connector_type: str = ""
    """The connector type its agents register with, stored on each agent row.
    Defaults to `label`."""

    advanced_fields: tuple[AdvancedField, ...] = ()
    """The settings a managed agent of this provider may carry."""

    credential_kinds: frozenset[str] = frozenset()
    """The kinds of credential a provider connection may hold for it."""

    supports_skills: bool = False
    """Whether its agent loads skills from a directory the hosted bootstrap can
    install connection skills into."""

    tools: tuple[ToolSpec, ...] = ()
    """The built-in tools its agents register."""

    session_start: TerminalStart | ConsoleStart = ConsoleStart(
        runtime=None, sign_in_command=None
    )
    """How the operator starts a session when the agent is addressed with none
    running."""

    def __post_init__(self) -> None:
        if not self.known_agent_type:
            object.__setattr__(self, "known_agent_type", self.id)
        if not self.connector_type:
            object.__setattr__(self, "connector_type", self.label)


AGENT_PROVIDERS: tuple[AgentProvider, ...] = (
    # Claude Code's known agent (`ClaudeCodeKnownAgent`) builds its own launch
    # command, so `session_start` is not read for it.
    AgentProvider(
        id="claude",
        label="Claude Code",
        known_agent_type="claude-code",
        advanced_fields=CLAUDE_FIELDS,
        credential_kinds=frozenset({"api-key", "setup-token"}),
        supports_skills=True,
        tools=(
            ToolSpec(name="Bash", description="Executes shell commands"),
            ToolSpec(name="Edit", description="Makes targeted edits to files"),
            ToolSpec(name="Write", description="Creates or overwrites files"),
            ToolSpec(name="Read", description="Reads file contents"),
            ToolSpec(name="Glob", description="Finds files by name pattern"),
            ToolSpec(name="Grep", description="Searches file contents for patterns"),
            ToolSpec(
                name="NotebookEdit", description="Modifies Jupyter notebook cells"
            ),
            ToolSpec(name="Agent", description="Spawns a subagent to handle a task"),
            ToolSpec(name="WebFetch", description="Fetches and processes web content"),
            ToolSpec(name="WebSearch", description="Performs web searches"),
            ToolSpec(name="Monitor", description="Runs background watch commands"),
            ToolSpec(name="Skill", description="Executes a skill"),
        ),
    ),
    AgentProvider(
        id="codex",
        label="Codex",
        connector_type="Codex CLI",
        advanced_fields=CODEX_FIELDS,
        credential_kinds=frozenset({"api-key", "auth-json"}),
        supports_skills=True,
        tools=(
            ToolSpec(name="Shell", description="Executes shell commands"),
            ToolSpec(name="ApplyPatch", description="Applies patches to files"),
            ToolSpec(name="Read", description="Reads file contents"),
        ),
        session_start=TerminalStart(command='codex "{prompt}"'),
    ),
    AgentProvider(
        id="opencode",
        label="OpenCode",
        connector_type="OpenCode CLI",
        advanced_fields=OPENCODE_FIELDS,
        credential_kinds=frozenset({"auth-json"}),
        supports_skills=True,
        tools=(
            ToolSpec(name="Bash", description="Executes shell commands"),
            ToolSpec(name="Edit", description="Edits existing files"),
            ToolSpec(name="Write", description="Writes new files"),
            ToolSpec(name="Read", description="Reads file contents"),
            ToolSpec(name="Grep", description="Searches file contents"),
            ToolSpec(name="Glob", description="Finds files by pattern"),
            ToolSpec(name="List", description="Lists directory contents"),
            ToolSpec(name="WebFetch", description="Fetches web pages"),
            ToolSpec(name="Task", description="Spawns a sub-agent"),
        ),
        # OpenCode reads its first positional argument as the project
        # directory, so the prompt has to go through `--prompt`.
        session_start=TerminalStart(command='opencode --prompt "{prompt}"'),
    ),
    AgentProvider(
        id="antigravity",
        label="Antigravity",
        connector_type="Antigravity CLI",
        credential_kinds=frozenset({"auth-json"}),
        tools=(
            ToolSpec(name="run_command", description="Executes shell commands"),
            ToolSpec(name="write_to_file", description="Writes files"),
            ToolSpec(name="replace_file_content", description="Edits existing files"),
            ToolSpec(
                name="multi_replace_file_content",
                description="Applies several edits to one file",
            ),
            ToolSpec(name="view_file", description="Reads file contents"),
            ToolSpec(name="grep_search", description="Searches file contents"),
            ToolSpec(name="find_by_name", description="Finds files by pattern"),
            ToolSpec(name="list_dir", description="Lists directory contents"),
            ToolSpec(name="read_url_content", description="Fetches web pages"),
            ToolSpec(name="search_web", description="Searches the web"),
            ToolSpec(name="call_mcp_tool", description="Calls a tool on an MCP server"),
            ToolSpec(name="invoke_subagent", description="Delegates to a subagent"),
        ),
        session_start=ConsoleStart(runtime="Antigravity CLI", sign_in_command="agy"),
    ),
    AgentProvider(
        id="cursor",
        label="Cursor CLI",
        credential_kinds=frozenset({"api-key"}),
        tools=(
            ToolSpec(name="shell", description="Executes shell commands"),
            ToolSpec(name="read_file", description="Reads file contents"),
            ToolSpec(name="write", description="Writes files"),
            ToolSpec(name="str_replace", description="Edits existing files"),
            ToolSpec(name="grep", description="Searches file contents"),
            ToolSpec(name="glob", description="Finds files by pattern"),
        ),
        session_start=ConsoleStart(runtime="Cursor CLI ACP", sign_in_command="agent"),
    ),
)


def agent_providers() -> tuple[AgentProvider, ...]:
    """Every provider, in the order a client offers them."""
    return AGENT_PROVIDERS


def provider_ids() -> list[str]:
    return [provider.id for provider in agent_providers()]


def agent_provider(provider_id: str) -> AgentProvider:
    """The provider named `provider_id`. Raises UnknownProvider, naming the
    providers there are, for one Switch does not run."""
    for provider in agent_providers():
        if provider.id == provider_id:
            return provider
    raise UnknownProvider(
        f"unknown provider {provider_id!r}; one of {', '.join(provider_ids())}"
    )


def _require_agent_provider(value: str) -> str:
    agent_provider(value)
    return value


AgentProviderId = Annotated[str, AfterValidator(_require_agent_provider)]
"""A provider id in a request body, refused unless the table has it."""
