import AddIcon from "@mui/icons-material/Add";
import AutoAwesomeOutlined from "@mui/icons-material/AutoAwesomeOutlined";
import CodeOutlined from "@mui/icons-material/CodeOutlined";
import TuneOutlined from "@mui/icons-material/TuneOutlined";
import { Button, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { type ReactNode, useId, useState } from "react";

export type CreateWay = "agent" | "console" | "yaml";

const WAYS: Record<CreateWay, { label: string; detail: string; icon: ReactNode }> = {
  agent: {
    label: "Create with your personal agent",
    detail: "Opens a chat with your agent",
    icon: <AutoAwesomeOutlined />,
  },
  console: { label: "Create in Console", detail: "Fill in the template form", icon: <TuneOutlined /> },
  yaml: { label: "Write the YAML here", detail: "Paste it in or load a file", icon: <CodeOutlined /> },
};

/**
 * "Create template" and the ways to do it. The first two hand over to
 * Switch Console; writing the YAML here is for someone on the web without
 * it. `ways` lists those this deployment offers, in order: there is no
 * personal agent to ask where switch-buddy is not served.
 */
export default function CreateTemplateMenu({
  ways,
  onChoose,
}: {
  ways: readonly CreateWay[];
  onChoose: (way: CreateWay) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const triggerId = useId();
  const menuId = useId();

  return (
    <>
      <Button
        id={triggerId}
        variant="contained"
        startIcon={<AddIcon />}
        aria-haspopup="menu"
        aria-controls={anchor ? menuId : undefined}
        aria-expanded={anchor ? "true" : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ flexShrink: 0 }}
      >
        Create template
      </Button>
      <Menu
        id={menuId}
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: { sx: { width: 300, mt: 0.5 } },
          list: { "aria-labelledby": triggerId, sx: { p: 0.5 } },
        }}
      >
        {ways.map((way) => (
          <MenuItem
            key={way}
            onClick={() => {
              setAnchor(null);
              onChoose(way);
            }}
            sx={{ alignItems: "flex-start", whiteSpace: "normal", px: 1.5, py: 1 }}
          >
            <ListItemIcon sx={{ minWidth: 28, mt: "2px", "& svg": { fontSize: 18 } }}>{WAYS[way].icon}</ListItemIcon>
            <ListItemText
              primary={WAYS[way].label}
              secondary={WAYS[way].detail}
              sx={{ my: 0 }}
              slotProps={{
                primary: { variant: "body2", sx: { fontWeight: 500 } },
                secondary: { variant: "caption", color: "text.secondary", display: "block" },
              }}
            />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
