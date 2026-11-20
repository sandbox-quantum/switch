"""Write scenarios_hard.json: 40 harder cases with five overlapping agents."""

import json
from pathlib import Path


def P(s, t, to=()):
    return {"sender": s, "sender_kind": "person", "text": t, "addressed": list(to)}


def A(s, t, to=()):
    return {"sender": s, "sender_kind": "agent", "text": t, "addressed": list(to)}


def M(s, t, thread=None):
    return {"sender": s, "text": t, "thread_id": thread}


room = {
    "name": "eng-platform",
    "instructions": (
        "Platform team room. Deploys and CI go to deploy-bot; cloud infrastructure, databases and cloud costs go to infra-bot; "
        "customer invoices and plans go to billing-bot; customer tickets and escalations go to support-bot, who is on call; "
        "docs and release notes go to docs-bot. People here also talk among themselves; agents should not jump into those."
    ),
}
agents = [
    {
        "name": "deploy-bot",
        "description": "Runs and watches CI pipelines and deployments; investigates failed builds and deploys, reruns and rolls back.",
        "role": "release",
    },
    {
        "name": "infra-bot",
        "description": "Cloud infrastructure: databases, queues, Kubernetes clusters, networking, capacity and the cloud bill.",
    },
    {
        "name": "billing-bot",
        "description": "Customer billing: pricing, plans, invoices, refunds, payment failures.",
    },
    {
        "name": "support-bot",
        "description": "Customer support tickets, escalations and account questions from customers.",
        "role": "on-call",
    },
    {
        "name": "docs-bot",
        "description": "Product documentation, guides, API reference and release notes.",
    },
]
deploy_thread = [
    P("sara", "prod deploy for 4.2 failed again"),
    A(
        "deploy-bot",
        "It failed at the database migration: the new index timed out. I can rerun it with a longer timeout or roll back.",
        ["sara"],
    ),
]
infra_thread = [
    P("lee", "the orders database is at 92% CPU"),
    A(
        "infra-bot",
        "It's the nightly report query doing a full table scan. I can add the index or move the report to the replica.",
        ["lee"],
    ),
]
recent_chatter = [
    P("tom", "morning!"),
    P("priya", "morning, coffee first"),
    P("tom", "standup moved to 10:30 today"),
    P("sara", "ok thanks"),
]

S = [
    # clear but with overlapping vocabulary
    (
        "deploy-vs-infra-pipeline",
        ["deploy-bot"],
        [],
        [],
        M("sara", "the CI pipeline has been queued for 40 minutes, can someone look?"),
    ),
    (
        "infra-db-disk",
        ["infra-bot"],
        [],
        [],
        M(
            "lee",
            "we're running out of disk on the analytics database, what are our options?",
        ),
    ),
    (
        "infra-cloud-cost",
        ["infra-bot"],
        [],
        [],
        M("priya", "why did our cloud bill jump 30% last month?"),
    ),
    (
        "billing-customer-invoice",
        ["billing-bot"],
        [],
        [],
        M(
            "priya",
            "acme says their October invoice charged them for 50 seats instead of 40",
        ),
    ),
    (
        "support-escalation",
        ["support-bot"],
        [],
        [],
        M(
            "tom",
            "a customer is threatening to churn because login has been broken for them since yesterday, who can pick this up?",
        ),
    ),
    (
        "docs-release-notes",
        ["docs-bot"],
        [],
        [],
        M("sara", "we need release notes for 4.2 before the deploy goes out"),
    ),
    (
        "cloud-bill-not-customer-bill",
        ["infra-bot"],
        [],
        [],
        M("lee", "can we get a breakdown of what we spend on Kubernetes versus RDS?"),
    ),
    (
        "customer-refund-not-cloud",
        ["billing-bot"],
        [],
        [],
        M("priya", "can we refund the duplicate payment from globex?"),
    ),
    (
        "rollback-request",
        ["deploy-bot"],
        [],
        [],
        M("tom", "4.2 is throwing 500s on checkout, should we roll back?"),
    ),
    (
        "queue-backlog",
        ["infra-bot"],
        [],
        [],
        M("lee", "the email queue has 200k messages backed up"),
    ),
    # thread continuations, including topic shifts
    (
        "thread-continue-rerun",
        ["deploy-bot"],
        deploy_thread,
        [],
        M("sara", "rerun it with the longer timeout please", "t1"),
    ),
    (
        "thread-shift-to-docs",
        ["docs-bot"],
        deploy_thread,
        [],
        M("sara", "while that runs, can the changelog mention the new index?", "t1"),
    ),
    (
        "thread-continue-index",
        ["infra-bot"],
        infra_thread,
        [],
        M("lee", "add the index, and do it tonight", "t2"),
    ),
    (
        "thread-shift-to-billing",
        ["billing-bot"],
        infra_thread,
        [],
        M("lee", "unrelated, but did the refund for globex go through?", "t2"),
    ),
    ("thread-ack", [None], deploy_thread, [], M("sara", "ok cool, thanks", "t1")),
    (
        "thread-person-to-person",
        [None],
        deploy_thread,
        [],
        M("tom", "sara are you around to watch it after lunch?", "t1"),
    ),
    (
        "thread-pronoun-it",
        ["deploy-bot"],
        deploy_thread + [P("sara", "roll back for now")],
        [],
        M("sara", "and let me know when it's done", "t1"),
    ),
    # people talking among themselves about agent topics
    (
        "people-debating-rollback",
        [None],
        [],
        [
            P("tom", "I think we should roll back 4.2"),
            P("sara", "I'd rather fix forward, the bug is small"),
        ],
        M("tom", "fair, let's give it an hour"),
    ),
    (
        "people-planning-db",
        [None],
        [],
        [
            P("lee", "we should move reporting to a replica this quarter"),
            P("priya", "agreed, I'll put it on the roadmap"),
        ],
        M("lee", "I'll write the design doc next week"),
    ),
    (
        "named-person-deploy",
        [None],
        [],
        [],
        M("tom", "sara can you check why the deploy failed when you get a minute?"),
    ),
    (
        "named-person-invoice",
        [None],
        [],
        [],
        M("sara", "priya, did you ever hear back from acme about the invoice?"),
    ),
    (
        "opinion-not-question",
        [None],
        [],
        [],
        M("lee", "honestly our CI has been flaky all week"),
    ),
    (
        "rhetorical",
        [None],
        [],
        [],
        M("tom", "who decided friday deploys were a good idea lol"),
    ),
    (
        "social",
        [None],
        [],
        recent_chatter,
        M("priya", "anyone want to grab lunch at 12?"),
    ),
    (
        "praise",
        [None],
        deploy_thread,
        [],
        M("sara", "nice work everyone on the release", "t1"),
    ),
    (
        "announcement",
        [None],
        [],
        [],
        M("tom", "reminder: the office is closed on monday"),
    ),
    # ambiguous, either answer acceptable
    (
        "ambiguous-db-migration-deploy",
        ["deploy-bot", "infra-bot"],
        [],
        [],
        M("sara", "the migration is locking the users table, what do we do?"),
    ),
    (
        "ambiguous-customer-billing-support",
        ["billing-bot", "support-bot"],
        [],
        [],
        M(
            "tom",
            "a customer says they were charged after cancelling and they're angry",
        ),
    ),
    (
        "ambiguous-docs-support",
        ["docs-bot", "support-bot"],
        [],
        [],
        M("priya", "customers keep asking how to rotate their API keys"),
    ),
    (
        "ambiguous-cost-or-billing",
        ["infra-bot", "billing-bot"],
        [],
        [],
        M("lee", "why is the bill so high this month?"),
    ),
    # instructions / roles
    (
        "on-call-escalation",
        ["support-bot"],
        [],
        [],
        M("tom", "we have a sev2 from a customer, who's on call?"),
    ),
    (
        "release-role",
        ["deploy-bot"],
        [],
        [],
        M("sara", "who's handling the release today?"),
    ),
    # nothing any agent covers
    (
        "out-of-scope-hiring",
        [None],
        [],
        [],
        M("priya", "how many interviews do we have this week?"),
    ),
    (
        "out-of-scope-design",
        [None],
        [],
        [],
        M("sara", "does anyone have the figma file for the new onboarding?"),
    ),
    ("vague", [None], [], [], M("tom", "hmm")),
    # longer context: the channel moved on to another topic
    (
        "context-moved-on",
        ["billing-bot"],
        [],
        [
            P("sara", "deploy failed again"),
            A("deploy-bot", "Rerunning with the cache cleared.", ["sara"]),
            P("sara", "thanks, it's green now"),
            P("priya", "switching topics: globex disputed their card payment"),
        ],
        M("priya", "what do we need from them to resolve it?"),
    ),
    (
        "context-agent-already-helping",
        ["infra-bot"],
        [],
        [
            P("lee", "orders db CPU is high again"),
            A("infra-bot", "Same report query. Moving it to the replica now.", ["lee"]),
        ],
        M("lee", "how long will that take?"),
    ),
    (
        "context-two-agents-recent",
        ["docs-bot"],
        [],
        [
            A("deploy-bot", "4.2 is deployed to production."),
            A("docs-bot", "Release notes for 4.2 are drafted and waiting for review."),
        ],
        M("sara", "can you add the migration change to them?"),
    ),
    (
        "context-person-reply-to-person",
        [None],
        [],
        [
            P("tom", "can someone review my PR for the retry logic?"),
            P("sara", "I'll take it after lunch"),
        ],
        M("tom", "thanks sara!"),
    ),
    (
        "question-to-room-after-chatter",
        ["infra-bot"],
        [],
        recent_chatter,
        M("lee", "is anyone else seeing timeouts from the redis cluster?"),
    ),
]
out = {
    "room": room,
    "agents": agents,
    "scenarios": [
        {"id": i, "expect": e, "thread": t, "recent": r, "message": m}
        for i, e, t, r, m in S
    ],
}
json.dump(out, open(Path(__file__).with_name("scenarios_hard.json"), "w"), indent=1)
print(len(S), "scenarios")
