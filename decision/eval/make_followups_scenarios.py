"""Write scenarios_followups.json: a busy team room where people talk to agents mid-conversation.

    uv run python eval/make_followups_scenarios.py

The cases follow patterns seen in real rooms, reworded, with made-up people and
agents: replies that continue an exchange with an agent (in a thread and at the
top level, often short), people answering people inside an agent's thread,
agents spoken to by a spoken form of their name, announcements and requests
aimed at people, and people talking about an agent rather than to it. The
agents' descriptions are as terse as real ones often are.
"""

import json
from pathlib import Path


def P(s, t, to=()):
    return {"sender": s, "sender_kind": "person", "text": t, "addressed": list(to)}


def A(s, t, to=()):
    return {"sender": s, "sender_kind": "agent", "text": t, "addressed": list(to)}


room = {"name": "product-eng", "instructions": None}
agents = [
    {"name": "worker-remote", "description": "Coding worker"},
    {
        "name": "worker-local",
        "description": "Claude Code running in a worker container",
    },
    {
        "name": "workforce-manager",
        "description": "Manager of the workforce hub: assigns tasks to worker agents and tracks their status.",
    },
    {
        "name": "pm-agent",
        "description": "Personal agent with PM skills: tracks user feedback, writes PRDs and status updates.",
    },
    {
        "name": "releaser",
        "description": "Cuts releases: tags core and desktop builds, opens pin-bump PRs, reports when they ship.",
    },
    {"name": "dev-2", "description": "Engineering agent that implements tickets."},
    {
        "name": "team-lead",
        "description": "Team lead agent: plans and splits work for the platform team.",
    },
]
history = [
    P("tom", "standup moved to 10:30 today"),
    P("ivy", "home page PR is up, screenshots in the description"),
    P("pia", "I'll collect the onboarding feedback by friday"),
    P("sam", "permissions work is almost done, then I can pick up the next one"),
    P("nora", "nice, thanks all"),
]
scenarios = []


def add(id, expect, sender, text, note, thread=None, recent=None):
    scenarios.append(
        {
            "id": id,
            "expect": expect,
            "note": note,
            "recent": history if recent is None else recent,
            "thread": thread or [],
            "message": {
                "sender": sender,
                "text": text,
                "thread_id": "t1" if thread else None,
            },
        }
    )


# Continuing a thread with the agent that just answered: that agent.
mgr = [
    P("nora", "manager whats up", ["workforce-manager"]),
    A(
        "workforce-manager",
        "Nothing new from me. One ticket is still waiting at the plan gate, about a day now.",
    ),
]
add(
    "fu-what-else",
    ["workforce-manager"],
    "nora",
    "ok what else",
    "Short follow-up in the manager's thread, right after it answered.",
    mgr,
)
add(
    "fu-you-here",
    ["workforce-manager"],
    "nora",
    "you here ?",
    "Nudge after a follow-up got no answer.",
    mgr + [P("nora", "ok what else")],
)
add(
    "fu-what-about",
    ["workforce-manager"],
    "nora",
    "what was that about ?",
    "Question about what the manager just said.",
    mgr,
)
add(
    "fu-which-ticket",
    ["workforce-manager"],
    "nora",
    "which ticket is it",
    "Follow-up on the manager's answer.",
    mgr,
)
rem = [
    P("nora", "please check why names go to the avatar service", ["worker-remote"]),
    A(
        "worker-remote",
        "It's the avatar fallback: an agent with no icon gets a generated face from an outside service, and the bridge sends people's initials to another one.",
    ),
]
add(
    "fu-when-happen",
    ["worker-remote"],
    "nora",
    "the bridge posts for someone who isn't an agent? when does that ever happen??",
    "Pushes back on the worker's answer.",
    rem,
)
add(
    "fu-hello",
    ["worker-remote"],
    "nora",
    "hello ?",
    "Nudge after a question in the worker's thread got no answer.",
    rem + [P("nora", "when does that ever happen??")],
)
add(
    "fu-can-we-change",
    ["worker-remote"],
    "nora",
    "ok we should never do that, can we change it and use hashes instead?",
    "Asks the worker for a change based on its answer.",
    rem,
)
add(
    "fu-still-used",
    ["worker-remote"],
    "nora",
    "are we still using it ??",
    "Follow-up question on the worker's answer.",
    rem,
)
pm = [
    P("pia", "post the feedback summary here", ["pm-agent"]),
    A(
        "pm-agent",
        "Feedback summary: 9 resolved, 4 in progress, 3 open. Biggest open item: workspace verification is too manual.",
    ),
]
add(
    "fu-where-from",
    ["pm-agent"],
    "nora",
    "where does this feedback summary come from ??",
    "Asks the agent that just posted the summary.",
    pm,
)
add(
    "fu-which-users",
    ["pm-agent"],
    "pia",
    "which users said that?",
    "Follow-up on the summary the agent posted.",
    pm,
)
wk = [
    P("sam", "make the wording changes listed above", ["worker-local"]),
    A(
        "worker-local",
        "Done: the PR has all 14 wording changes. Want me to also take screenshots of each page?",
    ),
]
add(
    "fu-yes-do-that",
    ["worker-local"],
    "sam",
    "yes, do that please while I review",
    "Answers the worker's offer.",
    wk,
)
add(
    "fu-also-docs",
    ["worker-local"],
    "sam",
    "and fix the broken docs link in the same PR",
    "Adds to the request the worker is working on.",
    wk,
)
rel = [
    P("nora", "new canary of core, then a desktop canary with it pinned", ["releaser"]),
    A(
        "releaser",
        "Core rc.5 is built and published. The pin-bump PR is up for the desktop app; merge it and I'll cut the canary.",
    ),
]
add(
    "fu-merged",
    ["releaser"],
    "nora",
    "merged",
    "Tells the releaser the PR it was waiting on is merged.",
    rel,
)
add(
    "fu-released-right",
    ["releaser"],
    "nora",
    "its released right ?",
    "Asks the releaser about the build it reported.",
    rel
    + [
        P("nora", "merged"),
        A("releaser", "Canary 9 is building; the x64 leg is in notarization."),
    ],
)
add(
    "fu-why-slow",
    ["releaser"],
    "nora",
    "why is the x64 taking so long now ?",
    "Asks about the build the releaser reported.",
    rel + [P("nora", "merged"), A("releaser", "Canary 9 is building.")],
)
dev = [
    P(
        "tom",
        "1. the add participant button should be its own button 2. sort rooms by latest activity",
    ),
    A("dev-2", "Got both, checking the code so I can tell you what each one costs."),
]
add(
    "fu-stop-processing",
    ["dev-2"],
    "nora",
    "dev don't process the feedback yet please",
    "Speaks to the agent that just took the feedback, by a short form of its name.",
    dev,
)
add(
    "fu-name-spaced",
    ["dev-2"],
    "nora",
    "dev 2 ??",
    "Spoken form of the agent's name, after it got no reply.",
    dev + [P("nora", "don't process the feedback yet please")],
)

# Continuing at the top level, right after an agent addressed the sender: that agent.
top_wk = history + [
    A(
        "worker-local",
        "@sam PR 1967 has all the wording changes. Want screenshots of each page too?",
        ["sam"],
    )
]
add(
    "top-yes",
    ["worker-local"],
    "sam",
    "yes",
    "One-word answer to the worker's question to him, at the top level.",
    recent=top_wk,
)
add(
    "top-add-screens",
    ["worker-local"],
    "sam",
    "add screenshots please.",
    "Answers the worker's offer at the top level.",
    recent=top_wk,
)
top_dev = history + [
    A(
        "dev-2",
        "@ivy two review comments on 1302 are from the bot; want me to fix them?",
        ["ivy"],
    )
]
add(
    "top-fix-them",
    ["dev-2"],
    "ivy",
    "yeah fix them ofc!",
    "Answers the agent's question at the top level.",
    recent=top_dev,
)
add(
    "top-rebase",
    ["dev-2"],
    "ivy",
    "rebase the pr too",
    "Adds to the agent's task at the top level.",
    recent=top_dev,
)
top_rel = history + [
    P("nora", "cut a canary please", ["releaser"]),
    A(
        "releaser",
        "@nora the pin-bump PR is up; merge it and I'll cut the canary.",
        ["nora"],
    ),
]
add(
    "top-merged",
    ["releaser"],
    "nora",
    "merged",
    "Tells the releaser at the top level that the PR it asked for is merged.",
    recent=top_rel,
)

# People answering people inside an agent's thread: nobody.
add(
    "pp-lets-do-that",
    [None],
    "tom",
    "yes let's do that",
    "Answers a colleague's question; the agent only logged it.",
    [
        P(
            "pia",
            "do you still want the brainstorm session tomorrow or push it to next week?",
        ),
        A("pm-agent", "Added it to the open items."),
    ],
)
add(
    "pp-done-thanks",
    [None],
    "eli",
    "Done, thank you",
    "Thanks a colleague for approving the merge.",
    [
        P("eli", "monitoring PR is up"),
        A(
            "team-lead",
            "This reads as a PR announcement, so I'm not taking any action.",
        ),
        P("nora", "we'll move the dashboards out later"),
        P("eli", "ok to merge based on this?"),
        P("nora", "yeah"),
    ],
)
add(
    "pp-yeah",
    [None],
    "nora",
    "yeah",
    "Answers a colleague's question about merging.",
    [
        P("eli", "monitoring PR is up"),
        A("team-lead", "Not taking any action on this."),
        P("eli", "ok to merge this one?"),
    ],
)
add(
    "pp-makes-sense",
    [None],
    "nora",
    "Makes sense ok, I would remove the line then",
    "Agrees with a colleague's point in the worker's thread.",
    wk
    + [
        P(
            "sam",
            "the colours aren't clear for colour-blind people, I'd drop the status line",
        )
    ],
)
add(
    "pp-reply-to-colleague",
    [None],
    "nora",
    "if we can make it today yes, otherwise no",
    "Answers a colleague's question about the release.",
    [
        A("worker-remote", "Home page branch is rebased."),
        P("pia", "is the home page going in with tomorrow's release?"),
    ],
)
add(
    "pp-colleague-question",
    [None],
    "tom",
    "how do i know what is done or not? we are still discussing changes",
    "Asks a colleague back.",
    [
        A("workforce-manager", "Release scope doc updated."),
        P("nora", "best way is to test it end to end locally, wdyt?"),
    ],
)
add(
    "pp-categories",
    [None],
    "tom",
    "if we dont have categories let's remove them, thanks",
    "Answers a colleague's question.",
    [
        A("dev-2", "Template page shipped."),
        P(
            "nora",
            "do we have categories on the template page? if not we can remove them right?",
        ),
    ],
)
add(
    "pp-ack-colleague",
    [None],
    "ivy",
    "I'll give it a shot",
    "Volunteers for a task a colleague offered to anyone.",
    [
        A("workforce-manager", "New task posted: free trial message."),
        P("tom", "whoever wants to pick this up, feel free"),
    ],
)

# Spoken names at the top level: that agent.
add(
    "nm-manager-hi",
    ["workforce-manager"],
    "nora",
    "hi manager whats up",
    "Greets the manager by its role name.",
)
add(
    "nm-remote-agent",
    ["worker-remote"],
    "nora",
    "remote worker please check this one out, an avatar service is sending names outside",
    "Speaks to the remote worker by description.",
)
add(
    "nm-pm",
    ["pm-agent"],
    "pia",
    "pm can you add Alex's feedback to the tracker",
    "Speaks to the PM agent by a short name.",
)
add(
    "nm-releaser",
    ["releaser"],
    "nora",
    "releaser new canary please",
    "Speaks to the releaser by name.",
)
add(
    "nm-dev-two",
    ["dev-2"],
    "tom",
    "dev 2 can you take the sorting change",
    "Spoken form of the agent's name.",
)

# Announcements and requests aimed at people: nobody.
add(
    "an-pr-own-agent",
    [None],
    "eli",
    "Hosted agents v1: monitoring, alerts and a dashboard, PR 1911. What: we now report on the cloud machines behind hosted agents.",
    "A PR announcement for reviewers.",
)
add(
    "an-pr-small",
    [None],
    "ivy",
    "Small changelog PR that needs approval: PR 1847",
    "Asks people for a review.",
)
add(
    "an-sick",
    [None],
    "tom",
    "a bit under the weather today so I might be slow",
    "Status for colleagues.",
)
add(
    "an-cla",
    [None],
    "ivy",
    "The CLA check is red on 1832 and 1835, can someone clear it and review 1832?",
    "Asks people to clear a check and review.",
)

# Jobs an agent covers, nobody tagged: that agent.
add(
    "job-release-status",
    ["releaser"],
    "nora",
    "did the canary from this morning ship?",
    "Release status is the releaser's job.",
)
add(
    "job-feedback",
    ["pm-agent"],
    "pia",
    "what are the top three open feedback items right now?",
    "Feedback tracking is the PM agent's job.",
)
add(
    "job-who-on-ticket",
    ["workforce-manager"],
    "sam",
    "who is working on the permissions ticket?",
    "Task tracking is the manager's job.",
)

# Talking about an agent, not to it: nobody.
add(
    "ab-about-manager",
    [None],
    "tom",
    "the manager agent has been really useful for tracking tickets",
    "Talks about the manager.",
)
add(
    "ab-compare",
    [None],
    "nora",
    "I think the remote worker is faster than the local one for reviews",
    "Compares two agents.",
)
add(
    "ab-dream",
    [None],
    "eli",
    "picking up which agent you're talking to without a tag has been my dream",
    "A comment about the product.",
)

out = Path(__file__).with_name("scenarios_followups.json")
out.write_text(
    json.dumps(
        {"room": room, "agents": agents, "scenarios": scenarios},
        indent=1,
        ensure_ascii=False,
    )
    + "\n"
)
print(f"wrote {len(scenarios)} scenarios to {out.name}")
