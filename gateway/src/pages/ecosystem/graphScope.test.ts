import { describe, expect, it } from "vitest";
import type { EcosystemGraphData } from "../../data/api";
import { graphInScope } from "./graphScope";

const GRAPH: EcosystemGraphData = {
  show_owners: false,
  nodes: [
    { id: "switch", kind: "switch", label: "Switch", sublabel: "" },
    { id: "type:claude-code", kind: "agent_type", label: "claude-code", sublabel: "2 agents" },
    { id: "agent:a1", kind: "agent", label: "mine", sublabel: "" },
    { id: "agent:a2", kind: "agent", label: "theirs", sublabel: "" },
    { id: "type:codex", kind: "agent_type", label: "codex", sublabel: "1 agent" },
    { id: "agent:a3", kind: "agent", label: "also theirs", sublabel: "" },
    { id: "bridge:b1", kind: "bridge", label: "Slack", sublabel: "slack · running" },
  ],
  edges: [
    { source: "switch", target: "type:claude-code" },
    { source: "type:claude-code", target: "agent:a1" },
    { source: "type:claude-code", target: "agent:a2" },
    { source: "switch", target: "type:codex" },
    { source: "type:codex", target: "agent:a3" },
    { source: "switch", target: "bridge:b1" },
  ],
};

describe("graphInScope", () => {
  it("shows a member only their agents and the types they have one of, keeping the apps", () => {
    const scoped = graphInScope(GRAPH, new Set(["a1"]));
    expect(scoped.nodes.map((node) => node.id)).toEqual([
      "switch",
      "type:claude-code",
      "agent:a1",
      "bridge:b1",
    ]);
    expect(scoped.nodes.find((node) => node.id === "type:claude-code")?.sublabel).toBe("1 agent");
    expect(scoped.edges).toEqual([
      { source: "switch", target: "type:claude-code" },
      { source: "type:claude-code", target: "agent:a1" },
      { source: "switch", target: "bridge:b1" },
    ]);
  });

  it("shows everything to whoever administers the workspace", () => {
    expect(graphInScope(GRAPH, null)).toBe(GRAPH);
  });
});
