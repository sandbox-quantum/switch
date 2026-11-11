from switch_core.bridges.collaboration.session.redaction import (
    format_safe_tool_detail,
    redact_secrets,
)


def test_redacts_openai_and_ai_keys():
    k1 = "sk-" + "proj-1234567890abcdef1234567890"
    k2 = "sk-ant-" + "api03-abcdef1234567890123456"
    raw = f"Calling OpenAI API with {k1} and {k2}"
    redacted = redact_secrets(raw)
    assert "sk-proj-" not in redacted
    assert "sk-ant-" not in redacted
    assert "[REDACTED: API KEY]" in redacted


def test_redacts_github_tokens():
    t1 = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    t2 = "github_pat_" + "11AAAAAAA01234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234"
    raw = f"git push with {t1} and {t2}"
    redacted = redact_secrets(raw)
    assert "ghp_" not in redacted
    assert "github_pat_" not in redacted
    assert "[REDACTED: GITHUB TOKEN]" in redacted


def test_redacts_slack_tokens():
    tok = "xoxb-" + "123456789012" + "-" + "1234567890123" + "-" + "abcdef1234567890abcdef12"
    raw = f"Slack WebClient(token='{tok}')"
    redacted = redact_secrets(raw)
    assert "xoxb-" not in redacted
    assert "[REDACTED: SLACK TOKEN]" in redacted


def test_redacts_aws_access_keys():
    k = "AKIA" + "IOSFODNN7EXAMPLE"
    raw = f"export AWS_ACCESS_KEY_ID={k}"
    redacted = redact_secrets(raw)
    assert "AKIAIOSFODNN7EXAMPLE" not in redacted
    assert "[REDACTED: AWS KEY]" in redacted


def test_redacts_google_api_keys():
    k = "AIza" + "SyD-1234567890abcdef1234567890abcde"
    raw = f"curl 'https://maps.googleapis.com/maps/api/geocode/json?key={k}'"
    redacted = redact_secrets(raw)
    assert "AIzaSyD" not in redacted
    assert "[REDACTED: GOOGLE KEY]" in redacted


def test_redacts_private_pem_keys():
    raw = """-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1234567890abcdef==
-----END RSA PRIVATE KEY-----"""
    redacted = redact_secrets(raw)
    assert "MIIEowIBAAKCAQEA0Y1234567890abcdef==" not in redacted
    assert "[REDACTED: PRIVATE KEY]" in redacted


def test_redacts_connection_string_passwords():
    raw = "Connected to postgresql://postgres:super_secret_p@ssw0rd!@db.internal:5432/production_db"
    redacted = redact_secrets(raw)
    assert "super_secret_p@ssw0rd!" not in redacted
    assert (
        "postgresql://postgres:[REDACTED: PASSWORD]@db.internal:5432/production_db"
        in redacted
    )


def test_redacts_key_value_assignments():
    raw = 'config = {"api_key": "mySecretPassword123", "db_password": "superHardPassword"}'
    redacted = redact_secrets(raw)
    assert "mySecretPassword123" not in redacted
    assert "superHardPassword" not in redacted


def test_redacts_custom_secrets():
    raw = "Executing command with company_internal_passphrase_2026 in production"
    redacted = redact_secrets(raw, custom_secrets=["company_internal_passphrase_2026"])
    assert "company_internal_passphrase_2026" not in redacted
    assert "[REDACTED]" in redacted


def test_format_safe_tool_detail_truncates_large_outputs():
    long_output = "Line of debug output from build script\n" * 100
    formatted = format_safe_tool_detail(long_output, max_length=500)
    assert len(formatted) <= 500
    assert "… [truncated:" in formatted
    assert "characters omitted]" in formatted


def test_format_safe_tool_detail_preserves_short_clean_output():
    short_output = "pytest: 14 passed in 0.5s"
    formatted = format_safe_tool_detail(short_output, max_length=500)
    assert formatted == "pytest: 14 passed in 0.5s"
