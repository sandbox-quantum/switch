"""The provider table, and that a provider added to it reaches everything that
depends on which providers exist."""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from switch_core.chats.views import _provider
from switch_core.feature_flags import ADDITIONAL_AGENT_PROVIDERS
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config
from switch_core.gateway.known_agents import (
    ClaudeCodeKnownAgent,
    GenericKnownAgent,
    known_agent_for,
    known_agents,
    offered_known_agents,
    provider_known_agent,
)
from switch_core.gateway.providers import router as providers_router
from switch_core.management.advanced_config import (
    provider_fields,
    validate_advanced_config,
)
from switch_core.management.schemas import DefinitionV1
from switch_core.management.service import _known_agent_registration
from switch_core.providers import registry
from switch_core.providers.registry import (
    AgentProvider,
    ProviderNotOffered,
    UnknownProvider,
    agent_provider,
    agent_providers,
    offered_provider_ids,
    provider_ids,
    require_offered_provider,
)
from switch_core.providers.schema import advanced_config_schema


def test_ids_known_agent_types_and_connector_types_are_unique() -> None:
    providers = agent_providers()
    for attribute in ("id", "known_agent_type", "connector_type", "label"):
        values = [getattr(provider, attribute) for provider in providers]
        assert len(values) == len(set(values)), attribute
        assert all(values), attribute


def test_each_providers_advanced_fields_are_well_formed() -> None:
    for provider in agent_providers():
        keys = [field.key for field in provider.advanced_fields]
        assert len(keys) == len(set(keys)), provider.id
        for field in provider.advanced_fields:
            if field.type == "select":
                assert field.options, (provider.id, field.key)
                assert field.options[0].value == "", (provider.id, field.key)
                assert field.accepted_values(), (provider.id, field.key)
            else:
                assert field.options is None, (provider.id, field.key)


def test_the_stored_identifiers_of_existing_providers_are_unchanged() -> None:
    # `known_agent_type` and `connector_type` are stored on agent rows, so an
    # existing provider's must never change.
    assert {
        provider.id: (provider.known_agent_type, provider.connector_type)
        for provider in agent_providers()
    } == {
        "claude": ("claude-code", "Claude Code"),
        "codex": ("codex", "Codex CLI"),
        "opencode": ("opencode", "OpenCode CLI"),
        "antigravity": ("antigravity", "Antigravity CLI"),
        "cursor": ("cursor", "Cursor CLI"),
        "deepseek-harness": ("deepseek-harness", "DeepSeek Harness"),
        "pi": ("pi", "Pi"),
        "copilot": ("copilot", "GitHub Copilot CLI"),
        "kiro": ("kiro", "Kiro CLI"),
        "mistral-vibe": ("mistral-vibe", "Mistral Vibe"),
        "goose": ("goose", "Goose CLI"),
        "qwen": ("qwen", "Qwen Code"),
        "droid": ("droid", "Droid CLI"),
        "cline": ("cline", "Cline CLI"),
        "junie": ("junie", "Junie CLI"),
    }


_AGENT_PROVIDERS_SRC = (
    Path(__file__).resolve().parents[4] / "console/packages/agent-providers/src"
)

# Where Switch Console defines each provider's `loginCommand`.
_CONSOLE_SIGN_IN = {
    "claude": ("claude/sign-in.ts", r"CLAUDE_LOGIN = '([^']+)'"),
    "codex": ("codex/sign-in.ts", r"CODEX_LOGIN = '([^']+)'"),
    "opencode": ("opencode/sign-in.ts", r"OPENCODE_LOGIN = '([^']+)'"),
    "antigravity": ("antigravity/runtime.ts", r"AGY_LOGIN = '([^']+)'"),
    "cursor": ("cursor/cursor-adapter.ts", r"CURSOR_LOGIN = '([^']+)'"),
    "deepseek-harness": (
        "deepseek-harness/deepseek-harness-acp.ts",
        r"DSH_LOGIN = '([^']+)'",
    ),
    "pi": ("pi/sign-in.ts", r"PI_LOGIN = '([^']+)'"),
    "copilot": ("copilot/copilot-acp.ts", r"COPILOT_LOGIN = '([^']+)'"),
    "kiro": ("kiro/kiro-acp.ts", r"KIRO_LOGIN = '([^']+)'"),
    "mistral-vibe": (
        "mistral-vibe/mistral-vibe-acp.ts",
        r"MISTRAL_VIBE_LOGIN = '([^']+)'",
    ),
    "goose": ("goose/goose-adapter.ts", r"GOOSE_LOGIN = '([^']+)'"),
    "qwen": ("qwen/qwen-acp.ts", r"QWEN_LOGIN = '([^']+)'"),
    "droid": ("droid/droid-adapter.ts", r"DROID_LOGIN = '([^']+)'"),
    "cline": ("cline/cline-adapter.ts", r"CLINE_LOGIN = '([^']+)'"),
    "junie": ("junie/junie-adapter.ts", r"JUNIE_LOGIN = '([^']+)'"),
}


def test_each_sign_in_command_is_the_one_switch_console_runs() -> None:
    # An offline reply tells the owner to sign the CLI in with this command,
    # and Switch Console tells them the same thing from its own table.
    assert set(_CONSOLE_SIGN_IN) == set(provider_ids())
    for provider in agent_providers():
        path, pattern = _CONSOLE_SIGN_IN[provider.id]
        found = re.search(pattern, (_AGENT_PROVIDERS_SRC / path).read_text())
        assert found is not None, provider.id
        assert provider.sign_in_command == found.group(1), provider.id


def test_an_unknown_provider_is_refused_with_the_ones_there_are() -> None:
    with pytest.raises(UnknownProvider) as raised:
        agent_provider("gemini")
    assert str(raised.value) == (
        "unknown provider 'gemini'; one of claude, codex, opencode, antigravity, cursor, "
        "deepseek-harness, pi, copilot, kiro, mistral-vibe, goose, qwen, droid, cline, junie"
    )


def test_only_claude_has_a_known_agent_of_its_own() -> None:
    specs = known_agents()
    assert list(specs) == [p.known_agent_type for p in agent_providers()]
    assert isinstance(specs["claude-code"], ClaudeCodeKnownAgent)
    assert all(
        isinstance(spec, GenericKnownAgent)
        for key, spec in specs.items()
        if key != "claude-code"
    )


NEW = AgentProvider(
    id="newcli", label="New CLI", sign_in_command="newcli login", flag=None
)


@pytest.fixture
def new_provider(monkeypatch: pytest.MonkeyPatch) -> AgentProvider:
    monkeypatch.setattr(registry, "AGENT_PROVIDERS", (*registry.AGENT_PROVIDERS, NEW))
    return NEW


class TestANewProvider:
    """A provider added with nothing but an id, a label, a sign-in command and
    no flag."""

    def test_its_defaults(self, new_provider: AgentProvider) -> None:
        assert new_provider.known_agent_type == "newcli"
        assert new_provider.connector_type == "New CLI"
        assert new_provider.advanced_fields == ()
        assert new_provider.tools == ()
        assert provider_ids()[-1] == "newcli"

    async def test_it_is_served_in_the_provider_list(
        self, new_provider: AgentProvider
    ) -> None:
        app = FastAPI()
        app.include_router(providers_router, prefix="/gateway")
        app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id="u")
        app.dependency_overrides[get_config] = lambda: SimpleNamespace(
            feature_flags={ADDITIONAL_AGENT_PROVIDERS: False}
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            providers = await client.get("/gateway/management/providers")
            advanced = await client.get("/gateway/management/advanced-config")
        assert providers.status_code == 200, providers.text
        assert providers.json()["providers"][-1] == {
            "id": "newcli",
            "label": "New CLI",
            "advanced_fields": [],
        }
        assert advanced.json()["providers"]["newcli"] == {"fields": []}

    def test_it_has_an_empty_advanced_configuration(
        self, new_provider: AgentProvider
    ) -> None:
        assert advanced_config_schema()["providers"]["newcli"] == {"fields": []}
        assert provider_fields("newcli") == []
        validate_advanced_config("newcli", {})
        with pytest.raises(ValueError, match="it has no advanced configuration"):
            validate_advanced_config("newcli", {"effort": "high"})

    def test_a_definition_may_name_it(self, new_provider: AgentProvider) -> None:
        assert DefinitionV1(provider="newcli").provider == "newcli"
        with pytest.raises(ValidationError, match="newcli has no setting 'effort'"):
            DefinitionV1(provider="newcli", advanced_config={"effort": "high"})

    def test_it_gets_a_known_agent(self, new_provider: AgentProvider) -> None:
        spec = known_agents()["newcli"]
        assert isinstance(spec, GenericKnownAgent)
        assert provider_known_agent("newcli").connector_type == "New CLI"
        assert spec.connector_type == "New CLI"
        assert spec.tools == []
        options = spec.parse_options({"repo_dir": "/r", "channels_enabled": True})
        assert options.model_dump() == {"auto_session": False, "repo_dir": "/r"}
        assert spec.build_profile(options).connection_model == "session_addressable"
        agent = SimpleNamespace(
            name="new.agent",
            metadata_={"known_agent_type": "newcli", "known_agent_options": {}},
        )
        resolved = known_agent_for(agent)  # type: ignore[arg-type]
        assert resolved is not None
        assert resolved[0].provider is new_provider

    def test_a_managed_agent_registers_through_it(
        self, new_provider: AgentProvider
    ) -> None:
        spec, options, metadata = _known_agent_registration(
            DefinitionV1(provider="newcli", directory="/w"), None
        )
        assert spec.provider is new_provider
        assert metadata == {
            "known_agent_type": "newcli",
            "known_agent_options": {"auto_session": True, "repo_dir": "/w"},
        }

    def test_a_registered_agent_of_it_shows_it_as_its_provider(
        self, new_provider: AgentProvider
    ) -> None:
        agent = SimpleNamespace(metadata_={"known_agent_type": "newcli"})
        assert _provider(agent, None) == "newcli"  # type: ignore[arg-type]
        claude = SimpleNamespace(metadata_={"known_agent_type": "claude-code"})
        assert _provider(claude, None) == "claude"  # type: ignore[arg-type]
        unknown = SimpleNamespace(metadata_={"known_agent_type": "gemini"})
        assert _provider(unknown, None) is None  # type: ignore[arg-type]


ADDITIONAL = {
    "deepseek-harness",
    "pi",
    "copilot",
    "kiro",
    "mistral-vibe",
    "goose",
    "qwen",
    "droid",
    "cline",
    "junie",
}


class TestTheAdditionalProvidersFlag:
    def test_it_gates_exactly_the_additional_providers(self) -> None:
        gated = {
            p.id for p in agent_providers() if p.flag == ADDITIONAL_AGENT_PROVIDERS
        }
        assert gated == ADDITIONAL
        assert all(
            p.flag in (None, ADDITIONAL_AGENT_PROVIDERS) for p in agent_providers()
        )

    def test_off_they_are_not_offered(self) -> None:
        off = {ADDITIONAL_AGENT_PROVIDERS: False}
        assert offered_provider_ids(off) == {
            "claude",
            "codex",
            "opencode",
            "antigravity",
            "cursor",
        }
        assert set(offered_known_agents(off)) == {
            "claude-code",
            "codex",
            "opencode",
            "antigravity",
            "cursor",
        }
        with pytest.raises(ProviderNotOffered, match="additional_agent_providers"):
            require_offered_provider("goose", off)
        require_offered_provider("claude", off)

    def test_on_every_provider_is_offered(self) -> None:
        on = {ADDITIONAL_AGENT_PROVIDERS: True}
        assert offered_provider_ids(on) == set(provider_ids())
        require_offered_provider("goose", on)

    def test_an_agent_already_on_one_still_resolves(self) -> None:
        assert provider_known_agent("goose").connector_type == "Goose CLI"
        assert known_agents()["goose"].connector_type == "Goose CLI"


_CONSOLE_PROVIDER_REGISTRY = (
    Path(__file__).resolve().parents[4]
    / "console/apps/switch-console-desktop/src/shared/core/providers/agent-provider-registry.ts"
)


def test_switch_console_gates_the_same_providers_behind_the_same_flags() -> None:
    text = _CONSOLE_PROVIDER_REGISTRY.read_text()
    block = re.search(r"PROVIDER_FLAGS[^=]*= \{(.*?)\};", text, re.DOTALL)
    assert block is not None
    console = dict(re.findall(r"'?([a-z-]+)'?: '([a-z_.]+)'", block.group(1)))
    assert console == {p.id: p.flag for p in agent_providers() if p.flag is not None}
