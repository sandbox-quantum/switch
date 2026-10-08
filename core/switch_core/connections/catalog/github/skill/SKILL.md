---
name: github
description: How to use GitHub from this cloud agent. Load before running git or gh — cloning, fetching, pushing, branches, pull requests or reviews.
---

# GitHub

Your owner gave this agent GitHub access to one or more accounts (users or
organizations). For each account, the access is to all of its repositories
that your owner can push to, or to selected repositories only. Nothing is
cloned for you: your workspace starts empty. Clone what you need into it, and
work on your own branches.

## What you can reach

- `gh` on your `PATH` is a wrapper that gets a fresh, short-lived token for
  every call. The `git` credential helper does the same for HTTPS to
  github.com. There is nothing to sign in to or renew.
- `gh` picks the account from the owner of, in this order: `-R owner/repo`
  (or `--repo`), the `owner/repo` that `gh repo <command>` names (as in
  `gh repo clone owner/repo`), `GH_REPO`, and the github.com `origin` remote
  of the current directory. If none names one and only one account is
  granted, it uses that one. When several accounts are granted, pass
  `-R owner/repo` (or set `GH_REPO`, e.g. for `gh api`) outside a clone. The
  error tells you the granted accounts.
- To see the granted accounts, and for each one "all repositories" or the
  selected ones (or why it is unavailable):

  ```sh
  sh -c "$(git config --get credential.https://github.com.helper | sed 's/^!//; s/ --git-credential$/ --list/')"
  ```

  To list every repository of an account granted all repositories:

  ```sh
  GH_REPO=<account>/<any-repo> gh api /installation/repositories --paginate --jq '.repositories[].full_name'
  ```

- If a repository is not granted, `git` fails with its usual authentication
  error. Tell the user what you could not reach. Do not look for other
  credentials.
- The token has exactly these permissions:
  - **Contents** read/write: clone, fetch, branch, commit, push.
  - **Pull requests** read/write: create, list, view, diff, comment, review.
  - **Metadata** read.
  Issues, Actions, check runs, commit statuses and workflow files are out of
  reach: a push that changes a file under `.github/workflows/` is rejected.
- Never print, echo, log or persist a token. Do not run `gh auth token`,
  `gh auth login` or `gh auth setup-git`. Do not set `GH_TOKEN` or
  `GITHUB_TOKEN`. Do not put a token in a remote URL, `.git/config`, a file, a
  commit or a message.

## Everyday commands

```sh
git clone https://github.com/<owner>/<repo>.git   # into your workspace
git switch -c <branch>                            # work on a branch, not the default one
git push -u origin <branch>

gh pr create --base <default-branch> --head <branch> --title "..." --body-file <path>
gh pr list --json number,title,state,headRefName,url
gh pr view <number> --json number,title,body,state,author,baseRefName,headRefName,url
gh pr diff <number>
gh pr review <number> --comment --body "..."   # or --approve / --request-changes
gh pr comment <number> --body "..."

gh api repos/{owner}/{repo}/pulls/<number>/comments    # inline review comments
```

Give `gh pr view` and `gh pr list` only the `--json` fields you need. Plain
`gh pr view` also asks for checks and projects, which this token cannot read,
and fails. Do not use `gh pr checks`, `gh issue`, `gh run` or `gh workflow`.
Use `--body-file <path>` for long text. `gh` never prompts here, so pass every
value as a flag.

## Etiquette

- Push branches and open pull requests. Do not push to the default branch or
  force-push a branch someone else works on, unless you are asked to.
- Link the pull request in the room when you open one. Keep its description
  short: what changed and how you checked it.
