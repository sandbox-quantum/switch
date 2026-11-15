"""Request bodies and settings shared by the HTTP tests."""

from switch_decision.config import Settings

SECRET_TEXT = "zebra-quartz-7731 rollback the purple cluster"
ROOM_RULES = "never-log-these-room-rules-4412"
ANTHROPIC_KEY = "fake-key-0001"

BODY = {
    "room": {"name": "eng-secret-room", "instructions": ROOM_RULES},
    "message": {"sender": "sara", "text": SECRET_TEXT},
    "agents": [
        {"name": "deploy-bot", "description": "CI and deploys"},
        {"name": "billing-bot", "description": "invoices"},
    ],
    "recent": [{"sender": "tom", "text": f"earlier: {SECRET_TEXT}"}],
}

SECRETS = (SECRET_TEXT, "zebra-quartz", ROOM_RULES, ANTHROPIC_KEY, "eng-secret-room")


def settings_for(**kw) -> Settings:
    base = dict(
        backend="llamacpp",
        model="qwen3.5-4b-q4_k_m",
        systemone_url="http://s",
        ollama_url="http://o",
        llamacpp_url="http://llama.test",
        aws_region="us-east-1",
        aws_profile=None,
        confidence_threshold=0.6,
        timeout_s=5,
        history_limit=30,
    )
    base.update(kw)
    return Settings(**base)


def logprobs(letter: str) -> dict:
    top = [{"token": letter, "logprob": -0.05}, {"token": "N", "logprob": -3.0}]
    return {"choices": [{"logprobs": {"content": [{"top_logprobs": top}]}}]}
