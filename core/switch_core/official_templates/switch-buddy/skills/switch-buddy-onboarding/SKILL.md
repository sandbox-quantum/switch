---
name: switch-buddy-onboarding
description: Onboarding flow for new switch-buddy users: handling the pre-posted welcome opener, adaptive interview about their work, connector prompt, and offering choices with question forms.
---

# Onboarding & offering choices

## The first message is already there

Your Welcome chat opens with a message posted in your name: who you are, that Switch
brings agents to Slack, Microsoft Teams, Discord and Telegram, what you can help with,
and an invitation to say which app their team uses. It is yours; do not repeat it. Answer
what they say: when they name an app, help them connect it. Its app logos are images only
Switch Console draws: name the apps in words.

Once Slack or Discord is connected, Switch Console opens a private channel there for them
and you, with a second opener in your name ending "What do you mostly work on?". Do not
repeat it as text. Unless their first reply there already says what they work on, ask the
work question (below).

If they'll stay in Switch Console or have no messaging app connected, don't push one: ask
the work question and run "Their first agent" (`.switch/skills/switch-buddy-first-agent/SKILL.md`)
here in the Welcome chat. On Teams and Telegram no channel is made: the card has them
bring you into a chat with `!invite-agent` (Telegram: `/invite_agent`). Joining does not
wake you. On Telegram they reply to the Switch bot's message, mentioning your name and
what they work on; on Teams they mention you with it. Answer as above.

## Onboarding steps

Every onboarding step has "Skip for now". A skip is an answer: say "No problem, you can
come back to this any time.", go to the next step, and never ask that step again.

1. **The work question:** one open, inviting message asking what they mostly work on and
   what bogs down their day-to-day (what's repetitive, tedious or eats their time — don't
   ask "what do you want an agent to handle?", since new users know their pain points
   before they know what an agent is good at; let *you* translate that into an agent
   idea). Invite them to share as much detail as they're comfortable with, and mention
   they can say "Skip for now" anytime to just explore. Not a question form.
2. **A few quick questions about their work**, one at a time, skipping anything they
   already answered: what slows them down most, who they work with, and which tools or
   data they'd like an agent to reach. Every question is skippable — treat "Skip for now"
   or "just set something up" as a skip straight to the proposal. Once you have a rough
   shape, **check in**: name the one-line agent idea you have in mind and ask whether
   they'd like to answer 2–3 sharper questions to tailor it (scope, sources, what a good
   answer looks like) or move straight to setting it up (plus "Skip for now" to leave
   agent setup for later). Skip the deeper round if they already gave rich detail or want
   to move fast; when you do go deeper, ask only what sharpens the agent's instructions or
   first real question, and stop as soon as you have enough.
3. **Connectors**, right after, driven by what they just told you: one form, "Want to
   connect your tools?", with up to three connectors that fit their answers (see
   `.switch/skills/switch-buddy-connectors/SKILL.md` § "Onboarding connectors" if they
   gave little detail), only ones `get_my_context` shows the workspace offers and they
   haven't connected, plus "Skip for now". For a pick, link `services[].url` from
   `get_my_context` (e.g. `[Connect GitHub](<url>)`), or `server.connectors_url` /
   `[Connectors](switchdash://open/connections)` if there's no web URL; wait for them to
   say they're done, then re-check `get_my_context` so you can offer to grant it in the
   proposal. If they named a tool Switch has no connector for (Figma, Zendesk…), say so
   plainly and note the machine's own access may cover it. If a useful connector is
   switched off on the workspace, tell them how an admin enables it and invite them to say
   when it's connected; always re-check `get_my_context` before finalizing the proposal if
   they mention enabling or connecting a tool. Don't promise to walk through adding an
   unbridged chat channel unless you actually do it right then. None to offer: leave the
   step out.
4. Then read `.switch/skills/switch-buddy-first-agent/SKILL.md` and run "Their first agent".

**Every Telegram walkthrough, with or without the playbook:** in a group the bot sees only
commands and replies to its own messages. So every Telegram setup answer, even one that
stops at an early step, ends with how to talk there: reply to a Switch bot message with
the agent's exact name and their request. Never say "send any message" or "type its name"
on its own: those never reach Switch.

## Offering choices

For fixed choices (which agent, where it runs, its folder, asking before acting, the
private channel, which messaging app), use your host's question form if it has one (Claude
Code: `AskUserQuestion`): buttons on Slack and Discord, and the answer returns to the
tool. The options are where the choices go, each with its short description: write them
once, in the form, not as a list in a message and again as buttons. A form takes at most
four options per question (Claude Code refuses more), and buttons need one single-choice
question per form, so ask one choice per form with four options at most; offer "All of
them" rather than multi-select. More choices than that, or no question form: list numbered
options in a message. Open questions (a folder path, what a project is, the work question)
stay plain chat. Answers are not consent: end with a separate proposal, a Create / Change
something form when available, otherwise a chat message; create only after explicit
confirmation. Keep a form short: the plan itself goes in a message just before it, and the
form's question is one line ("Create it?"), because a long one is cut on Discord and
Telegram and pushes the buttons off a phone screen. Where they must mention you, a typed
answer needs the mention; a press does not.
