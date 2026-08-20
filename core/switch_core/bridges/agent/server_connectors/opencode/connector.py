from __future__ import annotations

import logging
import re
import time
import uuid

from pydantic import Field

from switch_core.bridges.agent.protocol.types import (
    CommandCapabilities,
    CommandPayload,
    IntegrationProfile,
    MessagePayload,
    TaskProtocolConfig,
    ToolCallReport,
)
from switch_core.bridges.agent.server_connectors.base import (
    ConnectorReporter,
    DiscoveredAgent,
    ServerSideConnector,
    ServerSideConnectorConfig,
)
from switch_core.bridges.agent.server_connectors.opencode.client import OpenCodeClient

logger = logging.getLogger(__name__)

_SANITIZE_RE = re.compile(r"[^a-z0-9._-]")

# OpenCode pauses a session until a permission request is answered. This
# connector reports tool calls post-hoc and runs no pre-invocation mediation
# (see _INTEGRATION_PROFILE), so permission requests are auto-approved to keep
# the session from blocking. "always" so a given tool/pattern is not re-asked.
_PERMISSION_RESPONSE = "always"

_INTEGRATION_PROFILE = IntegrationProfile(
    connection_model="always_on",
    message_exchange=True,
    pre_invocation_mediation=[],
    post_invocation_mediation=[],
    event_reporting=["tool_calls"],
    task_protocol=TaskProtocolConfig(can_delegate=False, can_accept=False),
    # An always-on server-side session can always be reset from the room (the
    # connector receives the queued command event and starts a fresh session).
    # Compact / interrupt aren't modelled for this connector.
    command_capabilities=CommandCapabilities(
        reset="always",
        compact="unsupported",
        interrupt="unsupported",
    ),
)


class OpenCodeConnectionConfig(ServerSideConnectorConfig):
    server_url: str = Field(title="Server URL")
    username: str
    password: str = Field(json_schema_extra={"format": "password"})
    agent_name_prefix: str = Field(
        default="",
        title="Agent Name Prefix",
        description="Optional prefix for discovered agent names",
    )
    agent_allowlist: str = Field(
        default="",
        title="Agent Allowlist",
        description="Comma-separated agent names to include (empty = all)",
    )
    agent_blocklist: str = Field(
        default="",
        title="Agent Blocklist",
        description="Comma-separated agent names to exclude",
    )


class OpenCodeConnector(ServerSideConnector):
    def __init__(self, config: OpenCodeConnectionConfig) -> None:
        self._config = config
        self._client: OpenCodeClient | None = None
        self._sessions: dict[tuple[str, str], str] = {}
        self._agents_names_map: dict[str, str] = {}

    async def start(self) -> None:
        self._client = OpenCodeClient(
            server_url=self._config.server_url,
            username=self._config.username,
            password=self._config.password,
        )

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None
        self._sessions.clear()

    @property
    def client(self) -> OpenCodeClient:
        if self._client is None:
            raise RuntimeError("Connector not started — call start() first")
        return self._client

    async def discover_agents(self) -> list[DiscoveredAgent]:
        raw_agents = await self.client.list_agents()
        allowlist = {
            n.strip() for n in self._config.agent_allowlist.split(",") if n.strip()
        }
        blocklist = {
            n.strip() for n in self._config.agent_blocklist.split(",") if n.strip()
        }

        discovered = []
        for agent in raw_agents:
            name = agent.get("name", "")
            if allowlist and name not in allowlist:
                continue
            if name in blocklist:
                continue
            raw_name = self._config.agent_name_prefix + name
            sanitized = _SANITIZE_RE.sub("-", raw_name.lower())
            if not sanitized or not sanitized[0].isalnum():
                sanitized = "agent-" + sanitized
            self._agents_names_map[name] = sanitized
            discovered.append(
                DiscoveredAgent(
                    name=sanitized,
                    description=agent.get("description", f"OpenCode agent: {name}"),
                    integration_profile=_INTEGRATION_PROFILE,
                )
            )
        return discovered

    async def _ensure_session(self, agent_name: str, room_id: str) -> str:
        session_key = (agent_name, room_id)
        session_id = self._sessions.get(session_key)
        if session_id is None:
            session_id = await self.client.create_session()
            self._sessions[session_key] = session_id
            logger.debug(
                "Created OpenCode session %s for agent=%s room=%s",
                session_id,
                agent_name,
                room_id,
            )
        return session_id

    async def handle_message(
        self,
        agent_name: str,
        room_id: str,
        message: MessagePayload,
        reporter: ConnectorReporter,
    ) -> str | None:
        session_id = await self._ensure_session(agent_name, room_id)

        oc_agent_name = self._agents_names_map[agent_name]
        await reporter.set_typing(room_id, True)
        try:
            await self.client.prompt_async(session_id, message.body, oc_agent_name)
            return await self._stream_response(session_id, room_id, reporter)
        except Exception:
            logger.warning(
                "OpenCode session %s failed, creating new session", session_id
            )
            session_id = await self.client.create_session()
            self._sessions[(agent_name, room_id)] = session_id
            await self.client.prompt_async(session_id, message.body, oc_agent_name)
            return await self._stream_response(session_id, room_id, reporter)
        finally:
            await reporter.set_typing(room_id, False)

    async def _stream_response(
        self, session_id: str, room_id: str, reporter: ConnectorReporter
    ) -> str | None:
        """Subscribe to SSE, collect response text and tool calls, report events."""
        reported_tool_ids: set[str] = set()
        notified_tool_ids: set[str] = set()
        sent_text_ids: set[str] = set()
        responded_permission_ids: set[str] = set()

        async with self.client.subscribe_events() as events:
            async for event in events:
                logger.debug("Event received from opencode sse: %s", event)
                event_type = event.get("type", "")

                if event_type == "session.idle":
                    props = event.get("properties", {})
                    if props.get("sessionID") == session_id:
                        break

                if event_type == "permission.updated":
                    props = event.get("properties") or event.get("data", {})
                    if props.get("sessionID") != session_id:
                        continue
                    permission_id = props.get("id", "")
                    if not permission_id or permission_id in responded_permission_ids:
                        continue
                    responded_permission_ids.add(permission_id)
                    logger.info(
                        "Auto-approving OpenCode permission %s (%s) for session %s",
                        permission_id,
                        props.get("type") or props.get("title", ""),
                        session_id,
                    )
                    try:
                        await self.client.respond_permission(
                            session_id, permission_id, _PERMISSION_RESPONSE
                        )
                    except Exception:
                        logger.error(
                            "Failed to respond to OpenCode permission %s; session "
                            "may block waiting for approval",
                            permission_id,
                        )
                    continue

                if event_type not in (
                    "message.part.updated",
                    "message.part.updated.1",
                ):
                    continue

                props = event.get("properties") or event.get("data", {})
                if props.get("sessionID") != session_id:
                    continue

                part = props.get("part", {})
                part_type = part.get("type")

                if part_type == "text" and not part.get("synthetic"):
                    part_id = part.get("id", "")
                    text = part.get("text", "")
                    is_complete = part.get("time", {}).get("end") is not None
                    if is_complete and text and part_id not in sent_text_ids:
                        sent_text_ids.add(part_id)
                        await reporter.send_message(room_id, text)

                elif part_type == "tool":
                    state = part.get("state", {})
                    status = state.get("status")
                    tool_name = part.get("tool", "")
                    part_id = part.get("id", "")

                    if status == "running" and part_id not in notified_tool_ids:
                        notified_tool_ids.add(part_id)
                        args = state.get("input", {})
                        args_str = ", ".join(f"{k}: {v}" for k, v in args.items())
                        detail = (
                            f"Running tool: `{tool_name}({args_str})`"
                            if args_str
                            else f"Running tool: `{tool_name}`"
                        )
                        try:
                            await reporter.send_status(room_id, detail)
                        except Exception:
                            pass

                    elif (
                        status in ("completed", "error")
                        and part_id not in reported_tool_ids
                    ):
                        reported_tool_ids.add(part_id)
                        time_info = state.get("time", {})
                        duration_ms = None
                        if time_info.get("start") and time_info.get("end"):
                            duration_ms = int(
                                (time_info["end"] - time_info["start"]) * 1000
                            )
                        result = (
                            state.get("output", "")
                            if status == "completed"
                            else state.get("error", "")
                        )
                        report = ToolCallReport(
                            tool_name=tool_name,
                            arguments=state.get("input", {}),
                            result=result,
                            request_id=str(uuid.uuid4()),
                            timestamp=time.strftime(
                                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                            ),
                            duration_ms=duration_ms,
                        )
                        try:
                            await reporter.report_events(room_id, [report])
                        except Exception:
                            logger.warning(
                                "Failed to report tool call event (proceeding)"
                            )

        return None

    async def handle_context(
        self, agent_name: str, room_id: str, message: MessagePayload
    ) -> None:
        session_key = (agent_name, room_id)
        session_id = self._sessions.get(session_key)
        if session_id is None:
            return
        context = f"[{message.sender_name}]: {message.body}"
        await self.client.add_context(session_id, context)

    async def handle_command(
        self, agent_name: str, room_id: str, command: CommandPayload
    ) -> None:
        if command.command == "reset":
            self._sessions.pop((agent_name, room_id), None)
