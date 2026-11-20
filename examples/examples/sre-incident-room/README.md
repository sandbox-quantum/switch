# SRE Incident War Room — IncidentRoom Pattern

An autonomous incident response pattern using Switch AI with
multi-agent coordination in a shared Mattermost/Slack channel.

## Overview

When a SEV-1 alert fires, three specialized agents collaborate
in a shared Switch room alongside human responders:

| Agent | Role | Capability |
|-------|------|------------|
| `@triage-agent` | Incident Detective | Correlates stack traces with git commits to identify root cause |
| `@sre-agent` | Remediation Specialist | Prepares rollbacks, executes bash commands after human APPROVE |
| `@comms-agent` | Incident Commander | Publishes stakeholder updates, auto-generates post-mortems |

## Key Design Principles

- **Human-in-the-loop**: `@sre-agent` never deploys without explicit `APPROVE` in the room
- **Agent handoff via @mention**: Agents hand context to each other by tagging in the thread
- **Voice-driven**: Compatible with Wispr Flow for hands-free incident commands

## Live Results (from reference implementation)

- Root cause identified in < 60 seconds (11 agent tool calls)
- Full MTTR under 2 minutes
- Post-mortem auto-generated with zero human writing

## Reference Implementation

- **GitHub:** https://github.com/swatiicfai/IncidentRoom
- **Demo Video:** https://youtu.be/gvqgkVetPTc
- **Agents config:** [`switch.agents.yaml`](https://github.com/swatiicfai/IncidentRoom/blob/main/switch.agents.yaml)

## Quick Start

```bash
git clone https://github.com/swatiicfai/IncidentRoom
cd IncidentRoom
cp .env.example .env   # Set SWITCH_SERVER_URL
npm install
node src/simulate.js   # Trigger a live SEV-1 simulation
```

Built for the [Flip the Switch Hackathon 2026](https://wemakedevs.org/hackathons/switch).
