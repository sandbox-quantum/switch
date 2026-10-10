"""Agent management: managed agent definitions and the controllers that run them.

Off unless the `agent_management` feature flag is on. Management is the source of
truth for which agents are managed, how each is defined, which controller
runs it, controller enrollment and credentials, controller status, and
operations. It tells Core which controller runs each agent through Core's
`ControllerPresence`; from there Core lets that controller act as the agent
and carries the agent's events on the controller's one stream.

The boundary runs one way. This package may call into Core (agent
registration through `AgentCore`, the bindings in `ControllerPresence`),
but nothing in Core imports this package except the process wiring in
`switch_core.main`; `tests/switch_core/management/test_import_boundary.py`
holds that.

The design is `docs/design/agent-controllers-v1.md`, and the wire contract is
`docs/design/controller-contract-v1.md`.
"""
