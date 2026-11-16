import type { EcosystemGraphData } from "../../data/api";

/** The graph as a member is shown it: only their own agents, as the Agents
 * list and Home count them, and only the agent types they have one of.
 * Each type says how many of theirs it holds. Messaging apps stay: they are
 * the workspace's, like its users. `ownAgentIds` is null to show everything. */
export function graphInScope(
  data: EcosystemGraphData,
  ownAgentIds: ReadonlySet<string> | null,
): EcosystemGraphData {
  if (ownAgentIds === null) return data;
  const hidden = new Set(
    data.nodes
      .filter((node) => node.kind === "agent" && !ownAgentIds.has(node.id.replace(/^agent:/, "")))
      .map((node) => node.id),
  );
  const edges = data.edges.filter((edge) => !hidden.has(edge.source) && !hidden.has(edge.target));
  const agentsUnder = new Map<string, number>();
  for (const edge of edges) {
    if (edge.source.startsWith("type:") && edge.target.startsWith("agent:"))
      agentsUnder.set(edge.source, (agentsUnder.get(edge.source) ?? 0) + 1);
  }
  const empty = new Set(
    data.nodes
      .filter((node) => node.kind === "agent_type" && !agentsUnder.has(node.id))
      .map((node) => node.id),
  );
  return {
    ...data,
    nodes: data.nodes
      .filter((node) => !hidden.has(node.id) && !empty.has(node.id))
      .map((node) => {
        if (node.kind !== "agent_type") return node;
        const count = agentsUnder.get(node.id) ?? 0;
        return { ...node, sublabel: `${count} agent${count === 1 ? "" : "s"}` };
      }),
    edges: edges.filter((edge) => !empty.has(edge.source) && !empty.has(edge.target)),
  };
}
