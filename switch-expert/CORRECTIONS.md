# Corrections

Append-only. One entry each time the expert is proven wrong, or hits a question it could
not answer from anything in this repository.

**Write the entry the moment it happens**, not at the end of the conversation. Then fix the
knowledge file that was wrong and open a pull request. If you cannot open one, say in the
entry what you would have changed.

Never edit or delete an existing entry. A correction that is itself corrected gets a new
entry that supersedes the old one, so the record of what was believed when survives.

## Format

```
### YYYY-MM-DD — one-line summary

- **Said:** what the expert asserted.
- **Actually:** what is true.
- **Confirmed by:** where the real answer came from — a file and line, a command and its
  output, a release tag, or the person who corrected it.
- **Fixed in:** the knowledge file changed, and the PR — or `not fixed`, and why.
```

For a gap rather than a wrong answer, use the same shape with `**Said:** could not answer`
and describe what was asked.

## Entries

_None yet. This file starts empty on purpose — the first entry is the mechanism proving it
works, not a failure._
