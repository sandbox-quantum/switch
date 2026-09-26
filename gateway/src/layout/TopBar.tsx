import MenuBookOutlined from "@mui/icons-material/MenuBookOutlined";
import { Box, Button, Stack, Tooltip, Typography } from "@mui/material";
import { useLocation } from "react-router";
import { useAuth } from "../data/AuthContext";

const SECTION_LABELS: [prefix: string, label: string][] = [
  ["/ecosystem", "Ecosystem"],
  ["/rooms", "Rooms"],
  ["/resources", "Resources"],
  ["/agents", "Agents"],
  ["/collaborations", "Messaging Apps"],
  ["/registration-keys", "API Keys"],
  ["/users", "Users"],
  ["/workspace", "Workspace"],
];

const DOCS_URL = "https://docs.flintai.dev/flintai/switch/getting-started";

export default function TopBar() {
  const { pathname } = useLocation();
  const { session } = useAuth();
  const section = SECTION_LABELS.find(([prefix]) => pathname.startsWith(prefix))?.[1];
  const crumbs = [session?.tenant?.name, section].filter(
    (crumb): crumb is string => Boolean(crumb),
  );

  return (
    <Stack
      direction="row"
      sx={{
        height: "var(--top-bar-height)",
        alignItems: "center",
        justifyContent: "space-between",
        color: "text.primary",
        pr: 1,
      }}
    >
      <Typography sx={{ fontSize: "0.9375rem", fontWeight: 500, letterSpacing: "-0.02em", px: 2 }}>
        Switch
        {crumbs.map((crumb, i) => (
          <Box component="span" key={i}>
            <Box component="span" sx={{ opacity: 0.4, mx: 1 }}>
              /
            </Box>
            <Box component="span" sx={{ fontWeight: i === crumbs.length - 1 ? 700 : 500 }}>
              {crumb}
            </Box>
          </Box>
        ))}
      </Typography>

      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <Tooltip title="All Switch services are reachable">
          <Stack direction="row" sx={{ alignItems: "center", gap: 0.75, px: 1 }}>
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                backgroundColor: "var(--hoot-success)",
              }}
            />
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              System healthy
            </Typography>
          </Stack>
        </Tooltip>
        <Button
          color="inherit"
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          startIcon={<MenuBookOutlined sx={{ fontSize: 18 }} />}
          sx={{ fontWeight: 500 }}
        >
          Docs
        </Button>
      </Stack>
    </Stack>
  );
}
