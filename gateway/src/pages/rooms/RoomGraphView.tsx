import { Box, CircularProgress, Stack, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import {
  fetchInboundLinkedRooms,
  fetchLinkedRooms,
  type InboundLinkedRoomDetail,
  type LinkedRoomDetail,
} from "../../data/api";
import { useRoom } from "../../data/hooks";
import { useGraphCanvasTheme } from "../graphCanvasTheme";

interface GraphNode {
  id: string;
  label: string;
  description: string;
  kind: "center" | "expanded" | "leaf";
  fx?: number;
  fy?: number;
  x?: number;
  y?: number;
}

interface GraphLink {
  source: string;
  target: string;
}

interface RoomLinks {
  outbound: LinkedRoomDetail[];
  inbound: InboundLinkedRoomDetail[];
}

const CENTER_COLOR = "#A1C9D2";
const EXPANDED_COLOR = "#B69EE6";
const LEAF_COLOR = "#7EB6FF";

export default function RoomGraphView({ roomId }: { roomId: string }) {
  const { data: centerRoom } = useRoom(roomId);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Map<string, RoomLinks>>(new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

  // Load the center room's links + every expanded room's links on demand.
  useEffect(() => {
    const wanted = new Set<string>([roomId, ...expandedIds]);
    const toLoad = [...wanted].filter((id) => !cache.has(id));
    if (toLoad.length === 0) return;
    setLoadingIds((prev) => {
      const next = new Set(prev);
      toLoad.forEach((id) => next.add(id));
      return next;
    });
    let cancelled = false;
    Promise.all(
      toLoad.map(async (id) => {
        const [out, inb] = await Promise.all([
          fetchLinkedRooms(id),
          fetchInboundLinkedRooms(id),
        ]);
        return { id, outbound: out ?? [], inbound: inb ?? [] };
      }),
    ).then((results) => {
      if (cancelled) return;
      setCache((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          next.set(r.id, { outbound: r.outbound, inbound: r.inbound });
        }
        return next;
      });
      setLoadingIds((prev) => {
        const next = new Set(prev);
        toLoad.forEach((id) => next.delete(id));
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, expandedIds, cache]);

  // Build the visible subgraph: center + every neighbor of every expanded room.
  const { nodes, links } = useMemo<{ nodes: GraphNode[]; links: GraphLink[] }>(
    () => {
      if (!centerRoom) return { nodes: [], links: [] };

      const meta = new Map<string, { name: string; description: string }>();
      meta.set(centerRoom.id, {
        name: centerRoom.name,
        description: centerRoom.description,
      });

      const linkPairs = new Set<string>();
      const linkList: GraphLink[] = [];
      const neighborIds = new Set<string>();

      const addLink = (source: string, target: string) => {
        const key = `${source}->${target}`;
        if (linkPairs.has(key)) return;
        linkPairs.add(key);
        linkList.push({ source, target });
      };

      const hosts = [roomId, ...expandedIds];
      for (const hostId of hosts) {
        const entry = cache.get(hostId);
        if (!entry) continue;
        for (const out of entry.outbound) {
          meta.set(out.target_room_id, {
            name: out.target_room_name,
            description: out.target_room_description,
          });
          neighborIds.add(out.target_room_id);
          addLink(hostId, out.target_room_id);
        }
        for (const inb of entry.inbound) {
          meta.set(inb.source_room_id, {
            name: inb.source_room_name,
            description: inb.source_room_description,
          });
          neighborIds.add(inb.source_room_id);
          addLink(inb.source_room_id, hostId);
        }
      }

      const nodeList: GraphNode[] = [];
      nodeList.push({
        id: centerRoom.id,
        label: centerRoom.name,
        description: centerRoom.description,
        kind: "center",
        fx: 0,
        fy: 0,
      });
      const visible = new Set<string>([centerRoom.id, ...neighborIds]);
      for (const id of visible) {
        if (id === centerRoom.id) continue;
        const m = meta.get(id);
        nodeList.push({
          id,
          label: m?.name ?? id,
          description: m?.description ?? "",
          kind: expandedIds.has(id) ? "expanded" : "leaf",
        });
      }

      // Drop any link whose endpoints are not both visible.
      const visibleLinks = linkList.filter(
        (l) => visible.has(l.source) && visible.has(l.target),
      );
      return { nodes: nodeList, links: visibleLinks };
    },
    [centerRoom, roomId, expandedIds, cache],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 360 });

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

  useEffect(() => {
    if (!fgRef.current) return;
    fgRef.current.d3Force("charge")?.strength((n: GraphNode) =>
      n.kind === "center" ? -800 : n.kind === "expanded" ? -500 : -300,
    );
    fgRef.current.d3Force("link")?.distance(160);
    const t = setTimeout(() => fgRef.current?.zoomToFit(400, 80), 600);
    return () => clearTimeout(t);
  }, [nodes.length, links.length]);

  const canvas = useGraphCanvasTheme();

  const paintNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D) => {
      const { x = 0, y = 0, kind, label } = node;
      const radius = kind === "center" ? 10 : kind === "expanded" ? 8 : 7;
      const color =
        kind === "center"
          ? CENTER_COLOR
          : kind === "expanded"
            ? EXPANDED_COLOR
            : LEAF_COLOR;

      if (kind === "center" || kind === "expanded") {
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
      ctx.lineWidth = kind === "center" ? 2.2 : 1.4;
      ctx.stroke();

      // Plus/minus glyph for non-center nodes to hint at expand/collapse.
      if (kind !== "center") {
        const armLen = radius * 0.45;
        ctx.strokeStyle = canvas.nodeStroke;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - armLen, y);
        ctx.lineTo(x + armLen, y);
        if (kind === "leaf") {
          ctx.moveTo(x, y - armLen);
          ctx.lineTo(x, y + armLen);
        }
        ctx.stroke();
      }

      // Font in graph coordinates so it scales with the node when zooming.
      const fontGraphUnits = radius * 0.55;
      ctx.font = `${kind === "center" ? "600 " : ""}${fontGraphUnits}px ${canvas.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = canvas.label;
      const truncated = label.length > 32 ? label.slice(0, 31) + "…" : label;
      ctx.fillText(truncated, x, y + radius + fontGraphUnits * 0.4);
    },
    [canvas],
  );

  const handleNodeClick = useCallback((node: GraphNode) => {
    if (node.kind === "center") return;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
  }, []);

  const loading = loadingIds.size > 0;
  const isEmpty = nodes.length <= 1;

  return (
    <Box>
      <Stack
        direction="row"
        alignItems="baseline"
        justifyContent="space-between"
        sx={{ mb: 1 }}
      >
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          Linked rooms graph
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Click a node to expand or collapse its linked rooms.
        </Typography>
      </Stack>
      <Box
        ref={containerRef}
        sx={{
          width: "100%",
          height: 360,
          borderRadius: 2,
          overflow: "hidden",
          border: "1px solid",
          borderColor: "divider",
          backgroundColor: canvas.background,
          position: "relative",
        }}
      >
        {loading && (
          <Box
            sx={{
              position: "absolute",
              top: 8,
              right: 8,
              zIndex: 1,
            }}
          >
            <CircularProgress size={16} />
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
              No linked rooms yet.
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
            const r = n.kind === "center" ? 10 : n.kind === "expanded" ? 8 : 7;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={() => canvas.link}
          linkWidth={1}
          linkDirectionalArrowLength={5}
          linkDirectionalArrowRelPos={1}
          onNodeClick={(n) => handleNodeClick(n as GraphNode)}
          nodeLabel={(n) => {
            const node = n as GraphNode;
            return node.description
              ? `${node.label}\n${node.description}`
              : node.label;
          }}
          cooldownTicks={60}
          enableZoomInteraction
          enablePanInteraction
        />
      </Box>
    </Box>
  );
}
