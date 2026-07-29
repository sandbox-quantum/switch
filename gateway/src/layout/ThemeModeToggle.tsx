import DarkModeOutlined from "@mui/icons-material/DarkModeOutlined";
import LightModeOutlined from "@mui/icons-material/LightModeOutlined";
import MonitorOutlined from "@mui/icons-material/MonitorOutlined";
import { Box, Tooltip, useColorScheme } from "@mui/material";
import type { ComponentType } from "react";

const OPTIONS: { value: "light" | "dark" | "system"; label: string; icon: ComponentType<{ sx?: object }> }[] = [
  { value: "light", label: "Light", icon: LightModeOutlined },
  { value: "dark", label: "Dark", icon: DarkModeOutlined },
  { value: "system", label: "System", icon: MonitorOutlined },
];

export default function ThemeModeToggle() {
  const { mode, setMode } = useColorScheme();

  return (
    <Box
      role="radiogroup"
      aria-label="Colour theme"
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.25,
        borderRadius: "9999px",
        border: "1px solid",
        borderColor: "divider",
        p: 0.25,
      }}
    >
      {OPTIONS.map((option) => {
        const selected = mode === option.value;
        return (
          <Tooltip key={option.value} title={option.label}>
            <Box
              component="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.label}
              onClick={() => setMode(option.value)}
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                border: "none",
                cursor: "pointer",
                borderRadius: "9999px",
                transition: "color 150ms, background-color 150ms",
                backgroundColor: selected ? "var(--hoot-muted)" : "transparent",
                color: selected ? "text.primary" : "text.secondary",
                "&:hover": { color: "text.primary" },
                "&:focus-visible": { outline: "2px solid var(--hoot-ring)", outlineOffset: 1 },
              }}
            >
              <option.icon sx={{ fontSize: 14 }} />
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}
