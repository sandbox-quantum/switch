import pytest

from switch_core.sessions.contract import TURN_ENDED, TurnUpsert, parse_command


def test_cancel_contract_and_terminal_state():
    command = parse_command(
        {
            "contractVersion": 1,
            "commandId": "cancel",
            "sessionId": "session",
            "epoch": "epoch",
            "origin": {
                "surface": "mattermost",
                "actorId": "@sender:test",
                "roomId": "room",
                "messageId": "message",
                "threadId": None,
            },
            "body": {"type": "turn.cancel", "turnId": "turn"},
        }
    )
    assert command.body.type == "turn.cancel"
    assert command.body.turn_id == "turn"
    turn = TurnUpsert(
        type="turn.upsert", turn_id="turn", command_id="send", status="cancelled"
    )
    assert turn.status in TURN_ENDED
    with pytest.raises(ValueError):
        TurnUpsert(
            type="turn.upsert", turn_id="turn", command_id="send", status="canceled"
        )
    for body in [
        {"type": "turn.cancel"},
        {"type": "turn.cancel", "turnId": ""},
        {"type": "turn.cancel", "turnId": "turn", "actorId": "forged"},
    ]:
        with pytest.raises(ValueError):
            parse_command({**command.model_dump(by_alias=True), "body": body})
