---
name: canva
description: How to work with Canva designs, folders, assets and comments through the Canva connection your owner granted this agent. Load before searching, creating, editing, commenting on or exporting Canva designs.
---

# Canva

Your owner granted this agent their Canva connection. Its tools are on the
`canva` MCP server; there is nothing to set up or renew. Use these rather than
any other Canva app your runtime offers: only these follow your owner's grant.

## What the grant reaches

- **You act as your owner.** Everything you read is what they can see in
  Canva, and every design, comment or upload you make shows there as theirs.
- **The server lists every tool, whatever the connection allows.** Canva refuses
  what it doesn't, saying which scopes are missing: tell the user what you could
  not do.
- **Their plan sets the limits.** Autofill, brand kits, brand templates and
  resizing need Canva Pro or above. If Canva refuses one of these, say so
  rather than rebuilding the design another way without asking.
- When a tool is refused, tell the user what you could not do. If Switch says
  the grant was removed or the connection must be reconnected, your owner has
  to do that.

## Finding things

- `search-designs` and `search-folders` find work; `list-folder-items` shows
  what a folder holds. `resolve-shortlink` turns a short Canva link into
  something you can open.
- `get-design`, `get-design-pages` and `get-design-content` read a design.
  Read it before you change it.
- `list-comments` and `list-replies` read a design's comments.

## Making and changing designs

- `generate-design` offers candidates; `create-design-from-candidate` turns
  the one the user chose into a design. Show the candidates and let them
  choose.
- Edits happen in a transaction. `start-editing-transaction` opens one,
  `perform-editing-operations` makes the changes and
  `get-design-thumbnail` shows the result.
- **Nothing is saved until `commit-editing-transaction`.** Show the user the
  result and ask before committing, and use `cancel-editing-transaction` if
  they don't want it.
- Prefer `copy-design` when the user wants to try something on a design others
  rely on.
- Ask before `move-item-to-folder`, `merge-designs`, or commenting: other
  people on the design see the result.

## Exporting

Use `get-export-formats` first, then `export-design`. Free plans export at
standard quality. An export link is for the user who asked: don't post it
anywhere else without their say.

## Limits

Some tools are asynchronous: `get-create-design-async-job`,
`get-generate-image-job` and `get-separate-image-layers-job` report their
progress. Check them at a sensible pace rather than in a tight loop, as Canva
limits each person's calls per minute.
