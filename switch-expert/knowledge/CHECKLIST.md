# Before you build anything

_Last checked against: 2026-08-20._

Settle these before creating a single room. Skipping them is how people end up with six
rooms they do not need and three agents that do the same thing.

Work through them **in conversation**, a couple at a time. Do not send someone a numbered
battery of twelve questions.

## The goal

1. **What does done look like?** Not "an agent that helps with X" — what specifically will
   be different when it works. If this cannot be answered, stop; there is nothing to build
   yet.
2. **Who is it for?** One person, a team, anyone who wanders into a channel. This decides
   almost everything else.
3. **Does it already exist?** Check `RECIPES.md`. Adapting the nearest recipe beats
   designing from nothing.

## The people and the channels

4. **Where do these people already talk?** Build there. A new channel nobody visits is a
   dead setup. If they live in Slack, the room is that Slack channel.
5. **Which chat platform, and is it already connected to Switch?** Platforms differ in ways
   that will affect your design — see `GOTCHAS.md`. Do not assume the instance's default
   bridge is where the humans are; it very often is not.
6. **Is this one-to-one or one-to-many?** One person repeatedly needing help is a room per
   person. A team with a shared queue is a hub.

## The agents

7. **How many agents, really?** Default to one. Add a second only when it does a genuinely
   different job — the usual honest split is doer versus coordinator. Two agents that both
   "help with the project" is one agent.
8. **When should each one be awake?** Idle until someone addresses it is the right default.
   Anything else needs a reason.
9. **Where does each one run?** On whose machine, in which directory, with which
   credentials. Remember it is not your machine — ask what they have rather than
   prescribing. If the work wants a GPU or a big dataset, ask whether they have a box they
   reach over SSH.
10. **Who provisions them?** Not you. Say so early, so nobody sits waiting on you to create
    something you cannot create.

## Where the facts live

11. **What is portable and what is specific to this instance?** Portable how-to goes in the
    agent's instructions. Ids, keys, channel names, people to notify, lookup tables go in
    the room's instructions. If you are about to hard-code an id into a prompt, stop.
12. **Will this ever run in a second place?** If yes, no server-specific value may appear in
    any prompt — it goes in a table the agent looks its own row up in.
13. **Does anything need to be remembered between conversations?** If yes, that is a file
    the agent owns and updates as it goes, not something it holds in its head. Decide where
    it lives and who else can read it.

## Roles

14. **Do you actually need a role?** Only if the holder varies, or you need exactly one
    holder at a time, or you want to address the job rather than the agent. If one known
    agent will always do it, put the procedure in the agent and skip the role.

## The failure cases

15. **What happens when the agent is wrong?** Where does the correction go, and who applies
    it? "Someone will notice" is not an answer.
16. **What happens when it does not know?** It should say so plainly. Design that in rather
    than hoping.
17. **What is the blast radius?** If the agent can do something irreversible, put it behind
    an explicit human yes and confine it to one room.
18. **If its access runs through a person's account,** what else can it reach that it should
    not? Confine it to an allow-list before you build, not after.

## Before you call it done

19. **Has the person seen the design and said yes?** Room topology, what each agent does,
    what goes where. Propose it in the room and wait. Never start creating off your own
    judgement.
20. **Can they change it themselves?** If every adjustment needs you, it is not finished.
    The things they will want to tweak — wording, who gets notified, which sources — should
    be in room instructions or a file they can edit, not buried in a prompt.
