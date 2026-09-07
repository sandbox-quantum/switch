# Text messaging as a surface

What it would take to reach the agent from a phone — SMS, WhatsApp, or
something else — and which of those can do what was actually asked for:

> the agent could also participate in group chats on text just like it
> participates in group channels on Slack

Short version: **one option is already built, one is a week of work with a real
design problem, and one cannot do groups at all.**

---

## The thing to check first

**Telegram is already a working bridge**, 2,045 lines, in the tree. It has
groups, bot accounts, `@mentions`, media, and costs nothing per message. If the
user story is *"text my agent from the car"* and *"the agent sits in a group
chat with my team"*, that is **done today** — it needs a bot token and a
`POST /gateway/collaborations`, the same as Slack.

Discord is also already built, with the same properties.

So the real question is not "can the agent be reached from a phone" but **"must
the other participants be on SMS or WhatsApp specifically?"** If they can be on
Telegram, stop here. Everything below is the cost of them not being able to.

---

## User stories

Written in the same shape as the originals, and deliberately including the ones
that expose the hard parts.

### T-1 — Reach my agent with the keyboard I already have open

> As someone away from a laptop, I want to text my agent the way I text a
> person, so that a two-line instruction does not require finding an app.

Standing at a taxi rank: *"push the vendor call to Thursday and tell Priya."*
It does, and confirms in one line.

### T-2 — Put the agent in the group thread where the work is happening

> As someone coordinating something over a group text, I want the agent in the
> thread, so that it hears what everyone agreed rather than my summary of it.

Four people organising a customer visit in a group message. The agent reads
along and, when asked, produces the schedule — without anyone leaving the thread
they were already using.

### T-3 — Be told which thread something came from

> As someone in several group threads, I want to know which one the agent is
> answering, so that a reply meant for one team does not land in another.

Same requirement the multi-room work already solves — every event carries its
room — but it is worth stating because SMS makes it harder: there are no
channel names, only sets of phone numbers.

### T-4 — Not be charged for the agent thinking out loud

> As whoever pays the bill, I want the agent to be economical on a metered
> surface, so that a chatty turn is not a line item.

The "working on it…" indicator, a three-part reply, and a follow-up correction
are one Slack message and **five billable segments** on SMS.

### T-5 — Know it is me texting

> As someone whose phone number is my identity on this surface, I want the agent
> to recognise me and not someone spoofing my number.

The same question D6 records for email, with a different answer: carrier SMS is
harder to spoof than an email `From`, and not impossible.

---

## What each option actually costs

### SMS via Twilio (or Vonage, MessageBird)

**About a week**, and one genuine design problem.

The adapter contract is ~18 methods and the email bridge shows a minimal one is
653 lines — you declare away what the transport cannot do
(`supports_channel_creation = False` and so on) rather than faking it. Inbound
is a webhook, exactly like email, so the same public-endpoint work applies.

**The design problem is addressing.** Switch decides an agent is being spoken to
by `@name` mention. **SMS has no mentions.** In a group thread, every message
reaches every participant identically, so there is nothing in the wire format
that distinguishes "atlas, do this" from two humans talking. Three ways out,
none free:

- **A prefix convention** — a message starting `atlas:` or `@atlas` is
  addressed. Learnable, and people forget.
- **Answer everything** in a thread the agent is in. Natural, and on a metered
  surface with a model behind it, expensive and noisy.
- **A trigger word or a wake phrase.** Same as the first, with worse ergonomics.

Whichever, `_compute_addressed` needs a transport-specific path — today it is
`direct room` or `@mention`.

Four smaller costs, all real:

- **Groups are MMS group messaging.** Twilio supports it, largely US/Canada,
  and it needs a dedicated number per group. A Switch room maps to *a set of
  phone numbers*, not to a channel anyone joins or leaves. `create_channel`
  becomes "buy a number", and there is no membership API to read back.
- **Segmentation.** 160 characters per segment. A three-paragraph agent reply is
  a dozen segments and a dozen charges. The bridge should hard-cap outbound and
  say it is doing so.
- **No typing indicator, no threading, no formatting.** `send_typing` becomes a
  no-op; the runtime-state "working on it…" must be suppressed entirely or it
  becomes a text message per turn.
- **Identity is the phone number**, which is better than an email `From` and not
  proof. Worth a `authenticates_senders` decision at the same time as D6.

### WhatsApp

**It cannot do what was asked.** The official WhatsApp Business Cloud API is
business-to-customer 1:1 messaging; **group chats are not part of it**. The
libraries that do groups drive the consumer app unofficially and get numbers
banned. *(Worth re-checking before deciding — Meta has signalled interest in
group APIs — but treat group support as absent until it is documented.)*

Two further constraints even for 1:1:

- **The 24-hour window.** Outside 24 hours of the user's last message you may
  send only pre-approved template messages. An agent that wants to tell you
  something unprompted — which is US-3, the whole point of it — cannot, unless
  the thing it wants to say fits a template approved in advance.
- **Onboarding**: Meta Business verification, a dedicated number, template
  review. Weeks of calendar time, not engineering time.

1:1 WhatsApp is perhaps the same week as SMS, with better media and worse
proactivity. Group WhatsApp is not on the table.

### The others, briefly

| | Groups | Bot API | Verdict |
|---|---|---|---|
| **Telegram** | yes | yes | **already built** |
| **Discord** | yes | yes | **already built** |
| **SMS** | MMS groups, awkward | via Twilio | a week + the addressing problem |
| **WhatsApp** | **no** (official API) | yes | 1:1 only |
| **Signal** | yes | no official API | unofficial only |
| **iMessage** | yes | none | not possible |
| **RCS** | limited | emerging | too early |

---

## What I would do

**1. Try Telegram this week.** It is built, free, has groups and mentions, and
would answer T-1, T-2 and T-3 with configuration rather than code. If it turns
out the group needs to be people who will not install anything, you have learned
that cheaply — and if it works, the whole question is closed.

**2. If SMS is genuinely required, decide addressing first.** It is the one part
that is not mechanical, it changes the shape of `_compute_addressed`, and it is
the same mistake as `may_carry` if the code gets written before the rule is
chosen.

**3. Treat WhatsApp as 1:1 or not at all**, and do not promise group support on
it.

---

## What this does *not* need

Worth saying, because it is the reassuring part: **the multi-surface work
already covers this.** A new bridge is a new room type, and one agent already
holds rooms across several bridges on one connection, answers in the room that
asked, and carries an audience label per room. Adding SMS means writing an
adapter, not touching the protocol.

The two things a new surface *would* newly exercise:

- **`audience_of` needs a rule for it.** A group text is closer to `restricted`
  than anything; a 1:1 text is `private`; and whether SMS counts as `external`
  is a real question — the people in it are usually colleagues, but the
  transport is not the organisation's.
- **D6 applies again.** Each new surface gets its own answer to "is this really
  who it says it is", and the two-gate model (allowlist, then identity claim)
  already accommodates it.
