---
name: github
description: How to use GitHub from this cloud agent. Load before running git or gh against the granted repository — cloning, fetching, pushing, branches, issues, pull requests or reviews.
---

# GitHub

Your owner granted this agent access to one GitHub repository. It is already
cloned into your workspace, and `git` and `gh` are already signed in for it.

## Access

- `gh` on your `PATH` is a wrapper that fetches a fresh, short-lived token for
  every call. The `git` credential helper does the same for HTTPS pushes and
  fetches to github.com. Both refresh automatically; there is nothing to renew.
- The token only reaches the granted repository, with the permissions the
  owner approved when installing the Switch GitHub App. Other repositories,
  organization settings and your owner's personal account are out of reach.
  If a command fails with 403 or 404 against another repository, that is the
  scope, not a bug — say so rather than looking for a workaround.
- Never print, echo, log or persist a token. Do not run `gh auth token`,
  `gh auth login` or `gh auth setup-git`, do not set `GH_TOKEN` or
  `GITHUB_TOKEN`, do not put a token in a remote URL, `.git/config`, a file, a
  commit or a message. The wrapper and helper already supply it.

## Everyday commands

Run these from the workspace; `gh` picks the repository from its `origin`.

```sh
git switch -c <branch>                 # work on a branch, not the default one
git push -u origin <branch>

gh issue list --state open
gh issue view <number> --comments
gh issue create --title "..." --body "..."
gh issue comment <number> --body "..."

gh pr create --fill --base <default-branch>
gh pr list
gh pr view <number> --comments
gh pr diff <number>
gh pr checks <number>
gh pr review <number> --comment --body "..."   # or --approve / --request-changes
gh pr comment <number> --body "..."

gh api repos/{owner}/{repo}/pulls/<number>/comments   # anything the CLI lacks
```

Use `--body-file <path>` for long text instead of shell-quoting it. `gh` never
prompts in this environment, so pass every value it would ask for as a flag.

## Etiquette

- Push branches and open pull requests; do not push to the default branch or
  force-push a branch someone else is working on unless asked.
- Link the pull request in the room when you open one, and keep its
  description short: what changed and how you checked it.
