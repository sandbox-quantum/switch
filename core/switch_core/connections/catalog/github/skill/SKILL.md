---
name: github
description: How to work with the GitHub repositories your owner granted this agent. Load before running git or gh against them — cloning, fetching, branching, pushing, pull requests or reviews.
---

# GitHub

Your owner granted this agent some of their GitHub repositories, to read, or
to read and write. `git` over HTTPS and `gh` already work for them; there is
nothing to set up or renew.

## What the grant reaches

- **Read:** clone and fetch; list, view and diff pull requests; read their
  reviews and comments.
- **Write:** all of that, and push branches, open pull requests, comment and
  review.
- Only the granted repositories. Issues, Actions, check runs, commit statuses
  and workflow files are out of reach: a push that adds or changes a file under
  `.github/workflows/` is rejected. Other repositories, organization settings
  and your owner's own account are out of the grant's reach too.
- That is the scope, not a fault. When something is refused, tell the user what
  you could not do rather than retrying or looking for other credentials.
- If `git` or `gh` says GitHub refused its credentials, Switch replaces them:
  run the command once more.
- If `git` or `gh` says Switch gave no token (the repository is not in the
  grant, or Switch could not give one), it tried this machine's own GitHub
  sign-in instead, if there is one. If the command then succeeded, tell the
  user it acted as your owner's own account, not the Switch GitHub App, and
  outside the grant. If it failed, there was nothing to fall back to: tell the
  user what you could not do. If Switch says the grant was removed or
  changed, your owner has to grant it again.
- Through the grant, pushes, pull requests, comments and reviews appear as the
  Switch GitHub App's bot, not as your owner.
- Never print, log or store a credential, and leave git's credential settings
  and `gh`'s sign-in alone.

## Everyday commands

If a granted repository is already in your workspace, work there. Otherwise
clone it over HTTPS; `gh` picks the repository from the `origin` remote.

```sh
git clone https://github.com/<owner>/<repo>.git
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
Plain `gh pr view` also asks for checks, projects and other data the grant does
not reach, and fails; so do fields such as `statusCheckRollup`, `projectItems`
or `closingIssuesReferences`. Do not use `gh pr checks`, `gh issue`, `gh run`
or `gh workflow`; they need more than the grant gives.

An SSH remote (`git@github.com:...`) does not use the grant. Use HTTPS remotes
for granted repositories.

Use `--body-file <path>` for long text instead of shell-quoting it. `gh` does
not prompt here, so pass every value it would ask for as a flag.

## Etiquette

- Push branches and open pull requests; do not push to the default branch or
  force-push a branch someone else is working on unless asked.
- Link the pull request in the room when you open one, and keep its
  description short: what changed and how you checked it.
