# Documentation

Two sets of documents, with different owners and different audiences.

## `official/`

The reader-facing Switch documentation, published at
[docs.flintai.dev](https://docs.flintai.dev). It is written in
[`sandbox-quantum/docs`](https://github.com/sandbox-quantum/docs) as Mintlify MDX
and converted to Markdown here so that agents working in this repository can read
what users are told.

**Generated — do not edit.** Change the source pages in the docs repository, then
run `just sync-docs`. Every file under `official/` is rewritten on each run, so
an edit made here is lost without warning. Start at
[`official/TOC.md`](official/TOC.md), which lists the pages in the order the
site presents them.

## `old/`

Design and operator material written for this repository: the architecture
overview, the agent protocol, and per-bridge setup guides. None of it is
published, and none of it is covered by the pages under `official/` — where the
two describe the same thing, this is the deeper account and the published page is
the one users act on.
