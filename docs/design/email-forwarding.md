# Forwarding mail to an agent

Five user stories and a build plan for **D5** — reading a forwarded email
properly. Written after the first real use of the email bridge, where the first
genuine forward was lost outright and the second arrived cut in half.

Companion to `multi-surface-status.md` §1, which records the user story that
prompted this.

---

## The one-paragraph problem

Everything needed to hand an agent a file already works — **for a file attached
directly**. The adapter extracts it, the bridge uploads it to the Matrix media
repo, the runtime downloads it and hands the model a local path as `image_path`
or `file_path`, and `download_attachment` fetches anything from history. The
limit is 20 MB per file and no type is filtered.

**A forwarded message routes around all of it.** `_read_content` meets the
`message/rfc822` part that "forward as attachment" produces — Apple Mail's
default, Outlook's, every report-this-message flow — and does `str(nested)`,
pasting the whole raw MIME source into the message text with its attachments
base64-encoded inline. So the contract you forwarded is in the room as
unreadable encoded text, truncated at 16 KB, and the working attachment path
never sees it.

---

## User stories

### F-1 — Ask questions about a document someone sent me

> As someone who gets contracts, decks and reports by email, I want to forward
> one to my agent and **ask questions about its contents**, so that I do not
> have to read forty pages to find the three things I need.

Procurement forwards a signed MSA. *"What is the termination notice period, and
does the data-residency addendum survive termination?"* The agent reads the PDF
and answers, quoting the clauses.

**Needs:** a nested attachment becomes a real attachment, reaches the media
repo, and lands on the model as a readable local file.

### F-2 — Keep a running record from a stream of receipts

> As someone who expenses things all month, I want to forward receipts as they
> arrive and have my agent **keep the running total**, so that filing the claim
> is reading a list rather than reconstructing a month.

Twelve forwards over three weeks. Some are PDFs, several are phone photographs
of a paper receipt, two are one email carrying four receipts at once. At month
end: *"what's the total, and which are missing a VAT number?"*

**Needs:** many attachments in one message; images as images; a budget across
the whole message rather than per file; and the record to survive session
restarts — see *Outside this work*.

### F-3 — Catch up on a thread I was not on

> As someone coming back from leave, I want to forward a long thread and ask
> **what was decided and what is still open**, so that I can rejoin without
> reading thirty replies.

A thirty-message thread, quoted inline, several participants, two attachments
partway down. *"What did we agree on pricing, who owes what, and what is still
unanswered?"*

**Needs:** the *text* case at its worst — deep quoting, chronology, and who
said what. Far past any event size limit, and the part that matters most (the
recent replies) is at the top while the bulk is old quoting.

### F-4 — Compare things that arrived separately

> As someone running a bake-off, I want to forward each vendor's quote as it
> lands and later ask my agent to **compare them**, so that the comparison is
> not a spreadsheet I build by hand.

Three quotes over a week, each forwarded on arrival. Then: *"cheapest on a
three-year total, and where do the support terms differ?"*

**Needs:** attachments from *earlier* messages still fetchable — the
`download_attachment` path over room history — and reasoning across documents
that arrived days apart.

### F-5 — Forward me an introduction without letting my agent loose on it

> As someone whose colleagues forward me introductions, I want my agent to
> **note the person and the context without contacting them**, so that a
> forward is not an instruction to act.

A colleague forwards an intro to a prospect, with the prospect's original mail
quoted beneath. The agent should record who they are and what they want, and
must not email them, must not treat the quoted sender as someone who may
address it, and must not repeat the colleague's private covering note.

**Needs:** the *forwarder* and the *original sender* kept distinct — the
allowlist and addressing policy apply to the person who forwarded, never to a
name found inside the payload.

---

## What the stories demand

| Requirement | From |
|---|---|
| Nested attachments become real attachments | F-1, F-2, F-4 |
| Nested text becomes readable text, not MIME | all |
| Attribution per nested message — who, when, subject | F-3, F-5 |
| A budget across the whole tree, not per file | F-2 |
| Text that does not fit is *kept*, not cut | F-3 |
| Identity comes from the envelope, never the payload | F-5 |
| Attachments re-fetchable later from history | F-4 |

The last one already works and needs only for the first to be true.

---

## Build plan

Five phases, each shippable, in dependency order. Same process as the rest of
this branch: **tests first, then code, then a reviewer pass.** Everything lives
in `core/switch_core/bridges/collaboration/email/adapter.py` and its tests
unless noted.

### Phase 1 — read a nested message as a message *(unlocks F-1)*

The core of D5, and the phase that deletes the bug.

- `_read_content` recurses into `message/rfc822` rather than stringifying it.
- Nested text is extracted the same way the top level is — `plain` preferred,
  `html` rendered down — and appended with an attribution line naming the
  original `From`, `Date` and `Subject`.
- **Nested attachments become `Attachment`s** alongside the outer message's, so
  the existing upload path carries them.
- Depth limit (3 is generous — a forward of a forward of a forward), with the
  cut-off named in the body rather than silent.
- `_FORWARDED_BODY_MAX_CHARS` and the raw flatten are deleted.

*Done when:* a forwarded PDF arrives as a file the agent can read, and the body
reads as an email rather than as MIME.

### Phase 2 — budget the whole tree *(unlocks F-2)*

`agent_media_max_bytes` is applied per attachment with no cap on the total, so
one message carrying forty photographs is forty uploads.

- A total budget per inbound message, checked as attachments accumulate.
- When it is exceeded, the *remaining* files are recorded as
  `AttachmentFailure` with a reason naming the budget — the agent is told what
  it did not get, which the model already knows how to report.
- Order matters: keep the ones named in the body before the ones that are not,
  or failing that, smallest-first so a 19 MB video does not evict eleven
  receipts.

*Done when:* a message over budget delivers as much as it can and says exactly
what it dropped.

### Phase 3 — keep text that does not fit *(unlocks F-3)*

Today's cap cuts the tail off and says so. For a thread, the tail is most of the
content.

- When the assembled text exceeds `EMAIL_BODY_MAX_BYTES`, **attach the full
  text as a file** — `forwarded-thread.txt` — and put a readable head in the
  event with a line saying the rest is attached.
- The agent then reads it through the path that already works, so nothing is
  lost and the event stays small.

This is the insight worth stating plainly: **overflow text is an attachment
problem, not a truncation problem.** The machinery is already there.

*Done when:* a thirty-message thread arrives complete — a summary head in the
room, the whole thing readable as a file.

### Phase 4 — say who said what *(unlocks F-3, F-5)*

- Each nested message contributes a header line: sender, date, subject.
- The room message names the **forwarder** as the sender, always. Anyone quoted
  inside is content, not a participant.
- Nothing in the payload can affect the allowlist or the addressing policy —
  worth an explicit test, because "the agent treated a name inside a forwarded
  email as its owner" is the failure that matters here.

*Done when:* the agent can attribute a decision in a thread to a person, and a
name inside a forward cannot address it.

### Phase 5 — decide what a forward means for disclosure *(F-5, and §4.2 of the status doc)*

Not code yet — the decision that governs it.

A forward carries two audiences: the colleague's covering note, and the quoted
original. Today both land in one `external` room and `may_carry` refuses to
repeat either. The first real user overrode that by hand, and the agent's own
counter-proposal — *published material travels, private correspondence does
not* — is better than the rule as written.

Settle this before building enforcement on `may_carry`; Phases 1–4 do not
depend on it.

---

## Outside this work

Two things these stories need that are not the email path, recorded so they are
not mistaken for part of D5:

- **F-2 and F-4 need the record to survive a restart.** A running total or a
  quote comparison lives in the session's context window today and is gone when
  it restarts. Room documents exist and nothing connects them. See
  `multi-surface-status.md` §1b.
- **F-5's "must not email them" is free right now** only because outbound email
  does not exist. When it does (US-5, `email/reply.py`), the rule that a quoted
  address is not a correspondent has to be enforced rather than incidental.
