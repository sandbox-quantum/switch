"""Tests for security redaction and bounded tool detail formatting."""

from switch_core.bridges.collaboration.session.redaction import (
    format_tool_detail,
    redact_secrets,
)


def test_redact_pem_private_keys() -> None:
    raw = (
        "Here is my key:\n"
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIEowIBAAKCAQEA0Y123456789abcdef\n"
        "-----END RSA PRIVATE KEY-----\n"
        "Finished."
    )
    redacted = redact_secrets(raw)
    assert "-----BEGIN RSA PRIVATE KEY-----" not in redacted
    assert "[REDACTED: PRIVATE KEY]" in redacted
    assert "Finished." in redacted


def test_redact_api_keys() -> None:
    raw = (
        "OpenAI: sk-proj-1234567890abcdef1234567890\n"
        "Anthropic: sk-ant-api03-abcdef12345678901234567890\n"
        "GitHub: ghp_123456789012345678901234567890123456\n"
        "GitHub fine: github_pat_11AAAAAAA012345678901234567890123456789012345678901234567890\n"
        "Slack: xoxb-1234567890-abcdef\n"
        "AWS: AKIAIOSFODNN7EXAMPLE\n"
        "Google: AIzaSyA1234567890123456789012345678901\n"
    )
    redacted = redact_secrets(raw)
    assert "sk-proj-1234567890abcdef" not in redacted
    assert "[REDACTED: OPENAI KEY]" in redacted

    assert "sk-ant-api03" not in redacted
    assert "[REDACTED: ANTHROPIC KEY]" in redacted

    assert "ghp_123456" not in redacted
    assert "[REDACTED: GITHUB TOKEN]" in redacted

    assert "github_pat_" not in redacted

    assert "xoxb-1234567890" not in redacted
    assert "[REDACTED: SLACK TOKEN]" in redacted

    assert "AKIAIOSFODNN7EXAMPLE" not in redacted
    assert "[REDACTED: AWS KEY]" in redacted

    assert "AIzaSyA12345" not in redacted
    assert "[REDACTED: GOOGLE KEY]" in redacted


def test_redact_jwt_and_bearer_tokens() -> None:
    raw = (
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ."
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    )
    redacted = redact_secrets(raw)
    assert "eyJhbGci" not in redacted
    assert "[REDACTED: AUTHORIZATION]" in redacted or "[REDACTED: JWT]" in redacted


def test_redact_database_uri_passwords() -> None:
    uris = [
        "postgresql://postgres:super_secret_pwd@localhost:5432/switch_db",
        "mysql://app_user:p@ssw0rd123@db.internal:3306/production",
        "mongodb://admin:my_mongo_key@mongo.example.internal:27017/test",
    ]
    for uri in uris:
        redacted = redact_secrets(uri)
        assert "super_secret_pwd" not in redacted
        assert "p@ssw0rd123" not in redacted
        assert "my_mongo_key" not in redacted
        assert "[REDACTED: PASSWORD]" in redacted


def test_redact_mcp_authorization_headers() -> None:
    raw = "Authorization: Bearer mcp_access_token_9876543210\nAccept: application/json"
    redacted = redact_secrets(raw)
    assert "mcp_access_token" not in redacted
    assert "Authorization: [REDACTED: AUTHORIZATION]" in redacted
    assert "Accept: application/json" in redacted


def test_redact_environment_variables() -> None:
    raw = (
        "OPENAI_API_KEY=sk-test1234567890abcdef1234567890\n"
        "DB_PASSWORD=ultra_secure_pass\n"
        "AUTH_SECRET=my_jwt_signing_secret\n"
        "PUBLIC_HOST=localhost:8000"
    )
    redacted = redact_secrets(raw)
    assert "ultra_secure_pass" not in redacted
    assert "my_jwt_signing_secret" not in redacted
    assert "[REDACTED: SECRET]" in redacted
    assert "PUBLIC_HOST=localhost:8000" in redacted


def test_redact_custom_secrets() -> None:
    raw = "Connecting to internal cluster using token custom_corp_secret_token_xyz"
    redacted = redact_secrets(raw, custom_secrets=["custom_corp_secret_token_xyz"])
    assert "custom_corp_secret_token_xyz" not in redacted
    assert "[REDACTED]" in redacted


def test_format_tool_detail_input_cap() -> None:
    long_input = "SELECT * FROM users WHERE " + ("id > 100 AND " * 60)
    formatted = format_tool_detail(long_input, "10 rows returned", max_input=200)
    assert "[input cut," in formatted
    assert "10 rows returned" in formatted


def test_format_tool_detail_total_budget_cap() -> None:
    input_text = "cat /var/log/syslog"
    huge_output = "Nov 07 12:00:00 server app[123]: " + ("log line repeating " * 300)
    formatted = format_tool_detail(input_text, huge_output, max_total=500)
    assert len(formatted) <= 550  # Bounded within budget plus omission tag
    assert "[output cut," in formatted or "[truncated," in formatted
    assert "cat /var/log/syslog" in formatted


def test_format_tool_detail_redacts_secrets_automatically() -> None:
    input_text = "curl -H 'Authorization: Bearer sk-ant-secret12345678901234567890' https://api.anthropic.com"
    output_text = "Connected with postgresql://dbuser:mypassword@localhost:5432/db"
    formatted = format_tool_detail(input_text, output_text)
    assert "sk-ant-secret" not in formatted
    assert "mypassword" not in formatted
    assert "[REDACTED:" in formatted
