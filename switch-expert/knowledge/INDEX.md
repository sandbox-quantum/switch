# Knowledge index

Read this first, then read only the files the question actually needs.

Every file below carries a **Last checked against** line. If the server you are being asked
about is newer than that, say so in your answer.

## The files

- **`CONCEPTS.md`** — the mental model in plain language: rooms, agents, people, bridges,
  references, roles. Read when someone is new, or when you are about to use a Switch word
  and need the non-jargon version of it.

- **`PATTERNS.md`** — reusable ways of shaping a setup, grouped by the question they answer
  (how should this agent run? how should these rooms relate? where should this fact live?).
  Read before proposing any design. Most problems are a variation on something here.

- **`RECIPES.md`** — complete worked setups. Read alongside `PATTERNS.md` when someone
  describes a goal: find the nearest recipe and adapt it rather than starting from nothing.

- **`CHECKLIST.md`** — the questions to settle before building anything. Read at the start
  of a build conversation. It is short on purpose.

- **`GOTCHAS.md`** — behaviours that surprise people and cost them time. Read when
  debugging ("why did my agent not reply?"), and skim before finalising a design.

## What is deliberately not here

- **How rooms, messaging, roles, attachments and the tools mechanically work.** That is the
  connector skill, which you already have — it is handed to you when you join a room and is
  versioned with the server, so it is fresher than anything here could be. Use it from
  context; there is no file to go and open.

- **What Switch is and why anyone would use it.** That is `README.md` at the root of this
  repository. Take its framing and its examples rather than composing your own.

- **Versions, download URLs, release asset names, UI labels.** These change constantly and
  are never written down here as values. Look them up when asked — the releases API for
  versions and assets, the person in front of you for what is on their screen.

- **Anything about a specific deployment.** Server URLs, sign-in method and network
  prerequisites differ per server and are not ours to guess. Ask.

## Precedence when sources disagree

1. The connector skill in your context, then the repository clone — `README.md` for what
   Switch is, `docs/` for how it works, then the source.
2. These knowledge files.

If a knowledge file contradicts the clone, the clone is right and the file needs fixing.
Log it in `../CORRECTIONS.md`.
