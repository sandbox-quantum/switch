---
name: github
description: How to use GitHub from this cloud agent. Load before running git or gh against the granted repository — cloning, fetching, pushing, branches, pull requests or reviews.
---

# GitHub

Your owner granted this agent access to one GitHub repository. It is already
cloned into your workspace, and `git` and `gh` are already signed in for it.

## Access

- `gh` on your `PATH` is a wrapper that fetches a fresh, short-lived token for
  every call. The `git` credential helper does the same for HTTPS pushes and
  fetches to github.com. Both refresh automatically; there is nothing to renew.
- The token reaches only the granted repository, with exactly these
  permissions:
  - **Contents** read/write: clone, fetch, branch, commit, push.
  - **Pull requests** read/write: create, list, view, diff, comment, review.
  - **Metadata** read.
- Nothing else is granted. Issues, Actions, check runs, commit statuses and
  workflow files are out of reach: a push that adds or changes a file under
  `.github/workflows/` is rejected, and API operations requiring additional permissions are unavailable.
  Other repositories, organization settings and your owner's personal account
  are out of reach too. That is the scope, not a bug — tell the user what you
  could not do rather than retrying or looking for other credentials.
- Never print, echo, log or persist a token. Do not run `gh auth token`,
  `gh auth login` or `gh auth setup-git`, do not set `GH_TOKEN` or
  `GITHUB_TOKEN`, do not put a token in a remote URL, `.git/config`, a file, a
  commit or a message. The wrapper and helper already supply it.

## Everyday commands

Run these from the workspace; `gh` picks the repository from its `origin`.

```sh
git switch -c <branch>                 # work on a branch, not the default one
git push -u origin <branch>

gh pr create --base <default-branch> --head <branch> --title "..." --body-file <path>
gh pr list --json number,title,state,headRefName,url
gh pr view <number> --json number,title,body,state,author,baseRefName,headRefName,url
gh pr diff <number>
gh pr review <number> --comment --body "..."   # or --approve / --request-changes
gh pr comment <number> --body "..."

gh api repos/{owner}/{repo}/issues/<number>/comments   # conversation on a pull request
gh api repos/{owner}/{repo}/pulls/<number>/comments    # inline review comments
gh api repos/{owner}/{repo}/pulls/<number>/reviews
```

Pass `--json` with only the fields you need to `gh pr view` and `gh pr list`.
Plain `gh pr view` also asks for checks, projects and other data this token
cannot read, and fails; so do fields such as `statusCheckRollup`,
`projectItems` or `closingIssuesReferences`. Do not use `gh pr checks`, `gh issue`,
`gh run` or `gh workflow`; they need permissions the token does not have.

Use `--body-file <path>` for long text instead of shell-quoting it. `gh` never
prompts in this environment, so pass every value it would ask for as a flag.

## Etiquette

- Push branches and open pull requests; do not push to the default branch or
  force-push a branch someone else is working on unless asked.
- Link the pull request in the room when you open one, and keep its
  description short: what changed and how you checked it.
