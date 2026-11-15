"""The agent CLIs Switch runs: one entry per provider, and the only list of them.

Everything else that depends on which providers exist — definition
validation, the known-agent specs agents register through, advanced
configuration, the gateway's provider list — reads this table through the
functions below. Adding a provider is adding an entry; one with no advanced
settings or tools needs only an `id`, a `label`, its sign-in command and the
feature flag that offers it (None for none). What a client is offered and what
a new agent may name are the providers whose flag is on
(`offered_providers()`); everything that reads an agent already defined sees
them all.

Read the table through `agent_providers()` / `agent_provider()` rather than
importing `AGENT_PROVIDERS`, so every reader sees the same table.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated

from pydantic import AfterValidator

from switch_core.bridges.agent.protocol.types import ToolSpec
from switch_core.feature_flags import ADDITIONAL_AGENT_PROVIDERS
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

    flag: str | None
    """The feature flag that offers it, or None when every deployment does.
    Off, it is left out of what clients are offered and no new agent may name
    it, but an agent already defined on it keeps running."""

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
        flag=None,
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
        flag=None,
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
        flag=None,
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
        sign_in_command="agy acp --login",
        flag=None,
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
        flag=None,
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
        id="deepseek-harness",
        label="DeepSeek Harness",
        sign_in_command="dsh web",
        flag=ADDITIONAL_AGENT_PROVIDERS,
        tools=(
            ToolSpec(name="bash", description="Executes shell commands"),
            ToolSpec(name="pwsh", description="Executes PowerShell commands"),
            ToolSpec(name="read", description="Reads file contents"),
            ToolSpec(name="write", description="Writes files"),
            ToolSpec(name="edit", description="Edits existing files"),
            ToolSpec(name="grep", description="Searches file contents"),
            ToolSpec(name="glob", description="Finds files by pattern"),
            ToolSpec(name="web_fetch", description="Fetches web pages"),
            ToolSpec(name="web_search", description="Searches the web"),
            ToolSpec(name="todo_write", description="Keeps a task list"),
            ToolSpec(name="subagent", description="Delegates to a subagent"),
        ),
    ),
    AgentProvider(
        id="pi",
        label="Pi",
        sign_in_command="pi",
        flag=ADDITIONAL_AGENT_PROVIDERS,
        tools=(
            ToolSpec(name="read", description="Reads file contents"),
            ToolSpec(name="bash", description="Executes shell commands"),
            ToolSpec(name="edit", description="Edits existing files"),
            ToolSpec(name="write", description="Writes files"),
        ),
    ),
    AgentProvider(
        id="copilot",
        label="GitHub Copilot",
        sign_in_command="copilot login",
        flag=ADDITIONAL_AGENT_PROVIDERS,
        connector_type="GitHub Copilot CLI",
        tools=(
            ToolSpec(name="bash", description="Executes shell commands"),
            ToolSpec(name="view", description="Reads files and directories"),
            ToolSpec(name="create", description="Creates files"),
            ToolSpec(name="edit", description="Edits existing files"),
            ToolSpec(name="grep", description="Searches file contents"),
            ToolSpec(name="glob", description="Finds files by pattern"),
            ToolSpec(name="task", description="Delegates to a subagent"),
        ),
    ),
    AgentProvider(
        id="kiro",
        label="Kiro CLI",
        sign_in_command="kiro-cli login",
        flag=ADDITIONAL_AGENT_PROVIDERS,
    ),
    AgentProvider(
        id="mistral-vibe",
        label="Mistral Vibe",
        sign_in_command="vibe-acp --setup",
        flag=ADDITIONAL_AGENT_PROVIDERS,
    ),
    AgentProvider(
        id="goose",
        label="Goose",
        sign_in_command="goose configure",
        flag=ADDITIONAL_AGENT_PROVIDERS,
        connector_type="Goose CLI",
        tools=(
            ToolSpec(name="shell", description="Executes shell commands"),
            ToolSpec(name="write", description="Writes files"),
            ToolSpec(name="edit", description="Edits existing files"),
            ToolSpec(name="delegate", description="Delegates to a subagent"),
        ),
    ),
    AgentProvider(
        id="qwen",
        label="Qwen Code",
        sign_in_command="qwen",
        flag=ADDITIONAL_AGENT_PROVIDERS,
        tools=(
            ToolSpec(name="run_shell_command", description="Executes shell commands"),
            ToolSpec(name="write_file", description="Writes files"),
            ToolSpec(name="edit", description="Edits existing files"),
            ToolSpec(name="read_file", description="Reads file contents"),
            ToolSpec(name="grep_search", description="Searches file contents"),
            ToolSpec(name="glob", description="Finds files by pattern"),
            ToolSpec(name="web_fetch", description="Fetches web pages"),
            ToolSpec(name="agent", description="Delegates a task to a subagent"),
        ),
    ),
    AgentProvider(
        id="droid",
        label="Factory Droid",
        sign_in_command="droid",
        flag=ADDITIONAL_AGENT_PROVIDERS,
        connector_type="Droid CLI",
    ),
    AgentProvider(
        id="cline",
        label="Cline CLI",
        sign_in_command="cline auth",
        flag=ADDITIONAL_AGENT_PROVIDERS,
        tools=(
            ToolSpec(name="run_commands", description="Executes shell commands"),
            ToolSpec(name="read_files", description="Reads file contents"),
            ToolSpec(name="editor", description="Writes and edits files"),
            ToolSpec(name="search_codebase", description="Searches file contents"),
            ToolSpec(name="fetch_web_content", description="Fetches web pages"),
            ToolSpec(name="ask_question", description="Asks the user a question"),
            ToolSpec(name="spawn_agent", description="Delegates to a subagent"),
        ),
    ),
    AgentProvider(
        id="junie",
        label="Junie",
        sign_in_command="junie",
        flag=ADDITIONAL_AGENT_PROVIDERS,
        connector_type="Junie CLI",
        tools=(
            ToolSpec(name="Bash", description="Executes shell commands"),
            ToolSpec(name="Edit", description="Edits existing files"),
            ToolSpec(name="Write", description="Creates new files"),
            ToolSpec(name="Read", description="Reads file contents"),
            ToolSpec(name="Grep", description="Searches file contents"),
            ToolSpec(name="Glob", description="Finds files by pattern"),
            ToolSpec(name="WebSearch", description="Searches the web"),
        ),
    ),
)


def agent_providers() -> tuple[AgentProvider, ...]:
    """Every provider, in the order a client offers them."""
    return AGENT_PROVIDERS


def provider_ids() -> list[str]:
    return [provider.id for provider in agent_providers()]


def offered_providers(flags: Mapping[str, bool]) -> tuple[AgentProvider, ...]:
    """The providers whose flag is on in `flags`, in the order a client
    offers them."""
    return tuple(
        provider
        for provider in agent_providers()
        if provider.flag is None or flags[provider.flag]
    )


def offered_provider_ids(flags: Mapping[str, bool]) -> frozenset[str]:
    return frozenset(provider.id for provider in offered_providers(flags))


class ProviderNotOffered(ValueError):
    pass


def require_offered_provider(provider_id: str, flags: Mapping[str, bool]) -> None:
    """Raises UnknownProvider for a provider Switch does not run, and
    ProviderNotOffered, naming its flag, for one this deployment has off."""
    provider = agent_provider(provider_id)
    if provider.flag is not None and not flags[provider.flag]:
        raise ProviderNotOffered(
            f"{provider.label} is not offered on this server: it needs the "
            f"{provider.flag!r} feature flag."
        )


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
