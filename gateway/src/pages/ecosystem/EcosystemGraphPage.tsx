import {
  Alert,
  Box,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { useNavigate } from "react-router";
import type { EcosystemNodeKind } from "../../data/api";
import { useEcosystemGraph } from "../../data/hooks";
import { useGraphCanvasTheme } from "../graphCanvasTheme";

interface GraphNode {
  id: string;
  label: string;
  sublabel: string;
  // "owner" is a synthetic node kind injected when "Show owners" is on.
  kind: EcosystemNodeKind | "owner";
  fx?: number;
  fy?: number;
  x?: number;
  y?: number;
}

interface GraphLink {
  source: string;
  target: string;
}

const COLORS: Record<GraphNode["kind"], string> = {
  switch: "#A1C9D2",
  agent_type: "#B69EE6",
  agent: "#7EB6FF",
  bridge: "#7FD1A4",
  owner: "#E6B95C",
};

const RADII: Record<GraphNode["kind"], number> = {
  switch: 14,
  agent_type: 10,
  agent: 7,
  bridge: 10,
  owner: 8,
};

// Make raw connector_type keys (e.g. "claude_code") presentable.
function prettyType(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function EcosystemGraphPage() {
  const { data, loading, error } = useEcosystemGraph();
  const navigate = useNavigate();

  // "Show owners" inserts an owner node between each agent-type and its agents
  // (type -> owner -> agent). Owner names come from the ecosystem payload,
  // which only carries them when the server `ecosystem.show_owners` flag is ON —
  // so with the flag off this toggle reveals nothing.
  const [showOwners, setShowOwners] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setDimensions({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { nodes, links, counts } = useMemo<{
    nodes: GraphNode[];
    links: GraphLink[];
    counts: { agents: number; types: number; bridges: number };
  }>(() => {
    if (!data)
      return {
        nodes: [],
        links: [],
        counts: { agents: 0, types: 0, bridges: 0 },
      };
    const nodes: GraphNode[] = data.nodes.map((n) => ({
      id: n.id,
      // Agent-type labels arrive as raw connector_type keys; prettify them.
      label: n.kind === "agent_type" ? prettyType(n.label) : n.label,
      sublabel: n.sublabel,
      kind: n.kind,
      // Pin the Switch to the centre.
      ...(n.kind === "switch" ? { fx: 0, fy: 0 } : {}),
    }));

    // agent node id -> owner display name (only populated when the server flag
    // is on, so the toggle is inert otherwise).
    const ownerByAgentId = new Map<string, string>();
    for (const n of data.nodes) {
      if (n.kind === "agent" && n.owner_name) {
        ownerByAgentId.set(n.id, n.owner_name);
      }
    }

    // Build links. When "Show owners" is on, re-route each agent-type -> agent
    // edge through an owner node: type -> owner -> agent. Owner nodes are
    // deduped per (type, owner) so agents sharing an owner under a type collapse
    // onto one owner node.
    const links: GraphLink[] = [];
    const ownerNodeIds = new Set<string>();
    for (const e of data.edges) {
      const owner = showOwners ? ownerByAgentId.get(e.target) : undefined;
      if (owner) {
        const ownerNodeId = `owner:${e.source}:${owner}`;
        if (!ownerNodeIds.has(ownerNodeId)) {
          ownerNodeIds.add(ownerNodeId);
          nodes.push({
            id: ownerNodeId,
            label: owner,
            sublabel: "owner",
            kind: "owner",
          });
          links.push({ source: e.source, target: ownerNodeId });
        }
        links.push({ source: ownerNodeId, target: e.target });
      } else {
        links.push({ source: e.source, target: e.target });
      }
    }

    const counts = {
      agents: data.nodes.filter((n) => n.kind === "agent").length,
      types: data.nodes.filter((n) => n.kind === "agent_type").length,
      bridges: data.nodes.filter((n) => n.kind === "bridge").length,
    };
    return { nodes, links, counts };
  }, [data, showOwners]);

  useEffect(() => {
    if (!fgRef.current) return;
    fgRef.current
      .d3Force("charge")
      ?.strength((n: GraphNode) =>
        n.kind === "switch"
          ? -1200
          : n.kind === "agent_type" || n.kind === "bridge"
            ? -600
            : -200,
      );
    fgRef.current
      .d3Force("link")
      ?.distance((l: { target: GraphNode }) =>
        l.target.kind === "agent" ? 70 : 180,
      );
    const t = setTimeout(() => fgRef.current?.zoomToFit(400, 80), 800);
    return () => clearTimeout(t);
  }, [nodes.length, links.length]);

  const canvas = useGraphCanvasTheme();

  const paintNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D) => {
      const { x = 0, y = 0, kind, label } = node;
      const radius = RADII[kind];
      const color = COLORS[kind];

      if (kind !== "agent") {
        ctx.beginPath();
        ctx.arc(x, y, radius + 3, 0, 2 * Math.PI);
        ctx.fillStyle = `${color}30`;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = `${color}90`;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = kind === "switch" ? 2.4 : 1.4;
      ctx.stroke();

      // Font in graph coordinates so it scales with the node when zooming.
      const fontGraphUnits = radius * 0.55;
      ctx.font = `${kind === "switch" || kind === "agent_type" ? "600 " : ""}${fontGraphUnits}px ${canvas.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = canvas.label;
      const truncated = label.length > 32 ? label.slice(0, 31) + "…" : label;
      ctx.fillText(truncated, x, y + radius + fontGraphUnits * 0.4);
    },
    [canvas],
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (node.kind === "agent" || node.kind === "agent_type") {
        navigate("/agents");
      } else if (node.kind === "bridge") {
        navigate("/collaborations");
      }
    },
    [navigate],
  );

  const isEmpty = nodes.length <= 1;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          Ecosystem
        </Typography>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={showOwners}
              onChange={(e) => setShowOwners(e.target.checked)}
            />
          }
          label="Show owners"
          sx={{ mr: 1 }}
        />
        <Typography variant="caption" color="text.secondary">
          {data
            ? `${counts.agents} agents · ${counts.types} types · ${counts.bridges} apps`
            : null}
        </Typography>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box
        ref={containerRef}
        sx={{
          flex: 1,
          minHeight: 500,
          overflow: "hidden",
          border: "1px solid",
          borderColor: "divider",
          borderRadius: "16px",
          backgroundColor: canvas.background,
          position: "relative",
        }}
      >
        {loading && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1,
            }}
          >
            <CircularProgress />
          </Box>
        )}
        {!loading && isEmpty && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1,
            }}
          >
            <Typography variant="body2" color="text.secondary">
              No agents or collaboration apps yet.
            </Typography>
          </Box>
        )}
        <ForceGraph2D
          ref={fgRef}
          graphData={{ nodes, links }}
          width={dimensions.width}
          height={dimensions.height}
          backgroundColor={canvas.background}
          nodeRelSize={1}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={(node, color, ctx) => {
            const n = node as GraphNode;
            const r = RADII[n.kind];
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={() => canvas.link}
          linkWidth={1}
          onNodeClick={(n) => handleNodeClick(n as GraphNode)}
          nodeLabel={(n) => {
            const node = n as GraphNode;
            return node.sublabel
              ? `${node.label}\n${node.sublabel}`
              : node.label;
          }}
          cooldownTicks={120}
          enableZoomInteraction
          enablePanInteraction
        />
      </Box>
    </Box>
  );
}
