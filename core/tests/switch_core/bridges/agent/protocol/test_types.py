import pytest
from pydantic import ValidationError

from switch_core.bridges.agent.protocol.types import AgentEvent, MessageEditPayload


def test_agent_event_validates_message_edit() -> None:
    data = {
        "type": "message_edit",
        "room_id": "!room:example.com",
        "payload": {
            "message_id": "$orig_msg_123",
            "body": "corrected content",
            "edit_id": "$edit_msg_456",
            "revision": 1730700000123456,
        },
    }
    event = AgentEvent.model_validate(data)
    assert event.type == "message_edit"
    assert event.room_id == "!room:example.com"
    assert isinstance(event.payload, MessageEditPayload)
    assert event.payload.message_id == "$orig_msg_123"
    assert event.payload.body == "corrected content"
    assert event.payload.edit_id == "$edit_msg_456"
    assert event.payload.revision == 1730700000123456


def test_agent_event_rejects_unknown_event_type() -> None:
    data = {
        "type": "unrecognized_event_type",
        "room_id": "!room:example.com",
        "payload": {
            "body": "test",
            "timestamp": 123456,
            "sender": "@user:example.com",
            "sender_name": "User",
            "message_id": "$msg_1",
            "addressed": True,
        },
    }
    with pytest.raises(ValidationError):
        AgentEvent.model_validate(data)
