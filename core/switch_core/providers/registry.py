"""The agent CLIs Switch runs: one entry per provider, and the only list of them.

Everything else that depends on which providers exist — definition
validation, the known-agent specs agents register through, advanced
configuration, the gateway's provider list — reads this table through the
functions below. Adding a provider is adding an entry; one with no advanced
settings or tools needs only an `id` and a `label`.

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
class AgentProvider:
    id: str
    """What a definition, a launch and a provider connection name it by."""

    label: str
    """How people see it named."""

    sign_in_command: str
    """What its owner runs, on the machine an agent runs on, to sign the CLI
    in: Switch Console's `loginCommand` for the provider, which a test holds
    this to."""

    known_agent_type: str = ""
    """The known-agent spec its agents register through, stored on each agent
    as `known_agent_type`. Defaults to `id`."""

    connector_type: str = ""
    """The connector type its agents register with, stored on each agent row.
    Defaults to `label`."""

    advanced_fields: tuple[AdvancedField, ...] = ()
    """The settings a managed agent of this provider may carry."""

    tools: tuple[ToolSpec, ...] = ()
    """The built-in tools its agents register."""

    def __post_init__(self) -> None:
        if not self.known_agent_type:
            object.__setattr__(self, "known_agent_type", self.id)
        if not self.connector_type:
            object.__setattr__(self, "connector_type", self.label)


AGENT_PROVIDERS: tuple[AgentProvider, ...] = (
    AgentProvider(
        id="claude",
        label="Claude Code",
        sign_in_command="claude auth login",
        known_agent_type="claude-code",
        advanced_fields=CLAUDE_FIELDS,
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
        sign_in_command="codex login",
        connector_type="Codex CLI",
        advanced_fields=CODEX_FIELDS,
        tools=(
            ToolSpec(name="Shell", description="Executes shell commands"),
            ToolSpec(name="ApplyPatch", description="Applies patches to files"),
            ToolSpec(name="Read", description="Reads file contents"),
        ),
    ),
    AgentProvider(
        id="opencode",
        label="OpenCode",
        sign_in_command="opencode auth login",
        connector_type="OpenCode CLI",
        advanced_fields=OPENCODE_FIELDS,
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
    ),
    AgentProvider(
        id="antigravity",
        label="Antigravity",
        sign_in_command="antigravity-acp --login",
        connector_type="Antigravity CLI",
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
    ),
    AgentProvider(
        id="cursor",
        label="Cursor CLI",
        sign_in_command="agent login",
        tools=(
            ToolSpec(name="shell", description="Executes shell commands"),
            ToolSpec(name="read_file", description="Reads file contents"),
            ToolSpec(name="write", description="Writes files"),
            ToolSpec(name="str_replace", description="Edits existing files"),
            ToolSpec(name="grep", description="Searches file contents"),
            ToolSpec(name="glob", description="Finds files by pattern"),
        ),
    ),
    AgentProvider(
        id="openhands",
        label="OpenHands",
        sign_in_command="openhands login",
        connector_type="OpenHands CLI",
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
