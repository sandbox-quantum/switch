"""Regression cases from the Slack activity and permission review."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from slack_sdk.errors import SlackApiError
from slack_sdk.web.slack_response import SlackResponse

from switch_core.bridges.collaboration.adapter import RichContentThrottled, TurnActivity
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity,
    render_request,
)
from switch_core.bridges.collaboration.slack import adapter as slack_module
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.sessions.contract import (
    Answer,
    ApprovalContent,
    ApprovalOption,
    ApprovalResult,
    QuestionsResult,
)

from .test_session_activity import _item, _turn
from .test_session_questions_cards import FORM, _requests


@pytest.mark.parametrize("status", ["running", "completed"])
def test_tool_log_header_always_discloses_omitted_steps(status):
    items = [_item(itemId=f"step-{i}", title="x" * 500) for i in range(60)]
    message = render_activity(items, _turn(status), tool_log=True, elapsed_seconds=90)
    plan = message.blocks[0]
    assert len(plan["tasks"]) == 50
    assert "60 tool calls" in plan["title"]
    assert "10 earlier not shown" in plan["title"]
    assert plan["tasks"][0]["task_id"] == "step-10"


def text_size(value):
    if isinstance(value, dict):
        return len(value.get("text", "")) + sum(
            text_size(v) for k, v in value.items() if k != "text"
        )
    if isinstance(value, list):
        return sum(text_size(v) for v in value)
    return 0


@pytest.mark.parametrize("kind", ["approval", "questions"])
def test_resolved_details_have_a_combined_budget_and_keep_the_answer(kind):
    request = _requests("formAnswerLifecycle")["request-form"]
    if kind == "approval":
        request = request.model_copy(
            update={
                "content": ApprovalContent(
                    kind="approval",
                    title="command " * 1000,
                    detail="description " * 1000,
                    options=[
                        ApprovalOption(
                            option_id="yes", label="ALLOW " * 100, decision="accept"
                        )
                    ],
                ),
                "result": request.result.model_copy(
                    update={"result": ApprovalResult(kind="approval", option_id="yes")}
                ),
            }
        )
    else:
        questions = [
            request.content.questions[i % 3].model_copy(
                update={
                    "question_id": f"q{i}",
                    "title": "title " * 40,
                    "prompt": "prompt " * 1000,
                }
            )
            for i in range(20)
        ]
        request = request.model_copy(
            update={
                "content": request.content.model_copy(
                    update={"title": "context " * 1000, "questions": questions}
                ),
                "result": request.result.model_copy(
                    update={
                        "result": QuestionsResult(
                            kind="questions",
                            answers=[
                                Answer(
                                    question_id=q.question_id,
                                    selected_option_ids=[],
                                    custom_text="ANSWER " * 100,
                                )
                                for q in questions
                            ],
                        )
                    }
                ),
            }
        )
    message = render_request(
        request, FORM, responder_external_id="UOWNER", responder_name="Owner"
    )
    details = message.blocks[0]["tasks"][0]["details"]
    assert text_size(details) <= 2800
    assert "ALLOW" in str(details) if kind == "approval" else "ANSWER" in str(details)
    assert "UOWNER" in str(details)


async def test_slack_update_cooldown_honors_retry_after_across_messages(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(
        slack_module, "time", SimpleNamespace(monotonic=lambda: clock[0])
    )
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="test", app_token="test", workspace_id="T1"
        )
    )
    response = SlackResponse(
        client=None,
        http_verb="POST",
        api_url="https://slack.com/api/chat.update",
        req_args={},
        data={"ok": False, "error": "ratelimited"},
        headers={"Retry-After": "17"},
        status_code=429,
    )
    update = AsyncMock(side_effect=[SlackApiError("rate limited", response), None])
    monkeypatch.setattr(adapter, "update_blocks", update)
    content = TurnActivity([], _turn(), status_only=True)
    with pytest.raises(RichContentThrottled) as first:
        await adapter.update_rich("C1", "C1:1", content)
    assert first.value.retry_after == 17
    clock[0] += 16
    with pytest.raises(RichContentThrottled):
        await adapter.update_rich("C1", "C1:2", content)
    assert update.await_count == 1
    clock[0] += 1
    await adapter.update_rich("C1", "C1:2", content)
    assert update.await_count == 2
