"""Give every benchmark scenario a room history, so none is decided on the message alone.

    uv run python eval/add_history.py

Each scenario in the standard sets gets a `background`: 3 to 5 earlier top-level
messages from people talking among themselves (logistics and chatter no agent
covers), by people who are not otherwise in the scenario. `eval.py` sends them
before the scenario's own `recent` messages. The expected answers do not change.
The seed is fixed, so running this again writes the same files.
"""

import json
import random
from pathlib import Path

HERE = Path(__file__).parent
FILES = ["scenarios_hard.json", "scenarios_extra60.json", "scenarios_names.json"]
SEED = 5

LINES = [
    "standup moved to 10:30 today",
    "anyone up for lunch at 12?",
    "OOO tomorrow afternoon, dentist",
    "the wifi on the 3rd floor is flaky again",
    "reminder: retro at 4",
    "thanks for covering yesterday",
    "I'll be a few minutes late to the sync",
    "can we push the 1:1 to thursday?",
    "nice work on the demo yesterday",
    "who's going to the offsite in march?",
    "coffee machine is fixed btw",
    "back from leave, catching up on threads",
    "I'm heads down this morning, ping me if urgent",
    "happy friday all",
    "did the calendar invite go out for next week?",
    "lol",
    "agreed",
    "sounds good",
    "let's discuss in the planning meeting",
]
PEOPLE = ["ana", "jon", "lee", "kim", "omar", "rita", "ben", "zoe"]


def background_for(
    scenario: dict, agents: list[dict], rnd: random.Random
) -> list[dict]:
    taken = {scenario["message"]["sender"]}
    taken |= {
        m["sender"] for m in scenario.get("recent", []) + scenario.get("thread", [])
    }
    taken |= {a["name"] for a in agents}
    people = [p for p in PEOPLE if p not in taken]
    who = rnd.sample(people, rnd.randint(2, 3))
    return [
        {
            "sender": rnd.choice(who),
            "sender_kind": "person",
            "text": text,
            "addressed": [],
        }
        for text in rnd.sample(LINES, rnd.randint(3, 5))
    ]


def add_history(data: dict, rnd: random.Random) -> dict:
    for scenario in data["scenarios"]:
        agents = scenario.get("agents", data["agents"])
        scenario["background"] = background_for(scenario, agents, rnd)
    return data


def main() -> None:
    rnd = random.Random(SEED)
    for name in FILES:
        path = HERE / name
        data = add_history(json.loads(path.read_text()), rnd)
        path.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
        print(f"{name}: {len(data['scenarios'])} scenarios")


if __name__ == "__main__":
    main()
