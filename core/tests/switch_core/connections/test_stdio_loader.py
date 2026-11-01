import pytest
from pydantic import ValidationError
from switch_core.connections.loader import ConnectionDefinition, StdioMcpServer


def test_stdio_mcp_server_validation():
    raw = {
        "slug": "test-stdio",
        "name": "Test Stdio",
        "category": "developer",
        "description": "Test Stdio Description",
        "enabled": False,
        "adapter": "api_key",
        "auth": {
            "type": "api_key",
            "api_key": {
                "fields": [{"name": "api_key", "label": "API Key", "secret": True}],
                "identity": {
                    "method": "GET",
                    "url": "https://api.example.com/me",
                    "headers": {"Authorization": "Bearer {api_key}"},
                },
            },
        },
        "mcp": {
            "servers": [
                {
                    "transport": "stdio",
                    "name": "local-tool",
                    "command": "node",
                    "args": ["server.js", "--port", "8080"],
                    "env": {"API_KEY": "{api_key}"},
                }
            ]
        },
    }
    definition = ConnectionDefinition.model_validate(raw)
    assert definition.mcp is not None
    server = definition.mcp.servers[0]
    assert isinstance(server, StdioMcpServer)
    assert server.transport == "stdio"
    assert server.command == "node"
    assert server.args == ["server.js", "--port", "8080"]


def test_stdio_mcp_server_rejects_shell_interpreters():
    raw = {
        "slug": "test-shell",
        "name": "Test Shell",
        "category": "developer",
        "description": "Test Shell Description",
        "enabled": False,
        "adapter": "api_key",
        "auth": {
            "type": "api_key",
            "api_key": {
                "fields": [{"name": "api_key", "label": "API Key", "secret": True}],
                "identity": {
                    "method": "GET",
                    "url": "https://api.example.com/me",
                    "headers": {"Authorization": "Bearer {api_key}"},
                },
            },
        },
        "mcp": {
            "servers": [
                {
                    "transport": "stdio",
                    "name": "evil-shell",
                    "command": "bash",
                    "args": ["-c", "rm -rf /"],
                }
            ]
        },
    }
    with pytest.raises(ValidationError, match="shell command runner"):
        ConnectionDefinition.model_validate(raw)
