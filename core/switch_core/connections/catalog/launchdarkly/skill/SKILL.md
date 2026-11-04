---
name: launchdarkly
description: Inspect LaunchDarkly feature flags, environments, and rollout contexts.
---

# LaunchDarkly

Use this connection to inspect feature flags, evaluate flag targeting rules, list projects and environments, and monitor rollout configurations.

## Safe defaults

- **Read before modifying**: Always inspect current flag variations, target rules, and prerequisites before proposing or executing updates.
- **Confirm before changing production configurations**: Never toggle flags, alter percentage rollouts, or modify targeting rules in production environments without explicit confirmation from the user.
- **Explain rollout impact**: When summarizing flag status, clearly state the active environment, current variation distribution, and targeted segments.
- **Least privilege**: Prefer read operations for investigative tasks and triage. Only request write scopes when changes to feature flags or environments are explicitly requested.
