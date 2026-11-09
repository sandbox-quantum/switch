# Backends walked on the latest code (9 November 2026)

- **Stacks:** each was built from the branch: switch-core, Console in dev mode, a local Mattermost as the bridged chat, and scripted test agents (deploy, billing, docs, triage).
- **Timing:** latencies are what switch-core logged per decision, including the network to the decision service.

| Backend | Console Test | Untagged question in an auto-route room | Result |
|---|---|---|---|
| Strands Decider 4B on one NVIDIA L4 (eu-west-3), as the server default, token required | 0.99 confidence, 112–116 ms | deploy 178 ms, billing 199 ms, docs 211 ms; "thanks" goes to nobody (205 ms) | PASS |
| Haiku via the Anthropic API (workspace key) | 0.95, 1.4–2.6 s | deploy 2.9 s, billing 2.0 s, docs 2.7 s | PASS |
| Haiku on Bedrock (eu-west-3) | 0.95, 1.2–1.5 s | deploy 1.42 s, billing 1.51 s; "lunch anyone?" goes to nobody (1.60 s) | PASS |
| Self-hosted endpoint (Qwen on llama.cpp, CPU) | 1.00, 4.0 s cold, then about 0.1 s | — | PASS |
| None | Test disabled | Room shows "On, but unavailable" with the reason | PASS |
| Run on my machine (#1530): an Apple-silicon Mac, Qwen3.5-4B | 1.00, 0.32–0.53 s | deploy 811 ms, billing 704 ms, docs 705 ms. Owner demoted: the machine is sent nothing, the reason is shown, and the triage agent gets the message. Owner restored: decided again (751 ms) | PASS |

- **Key handling:** a saved Anthropic key shows only as its last four characters (blurred here). After switching to Bedrock, going back to Haiku (Anthropic) without entering the key is refused, on both Save and Test.
- **Outage:** with the decision service stopped, an untagged reply in an agent's thread went only to the triage agent, and the room got the "Auto-route is unavailable" notice.
