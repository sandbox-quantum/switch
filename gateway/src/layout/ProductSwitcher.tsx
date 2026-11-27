import CheckOutlined from "@mui/icons-material/CheckOutlined";
import ExpandMoreOutlined from "@mui/icons-material/ExpandMoreOutlined";
import { Box, Popover, Stack, Typography } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import { useRef, useState } from "react";

/** Switch Trust's app, the address the server links Trust policies to. */
const TRUST_URL = "https://app.switchagents.ai";

const VIGILANT_FLAME = "oklch(0.752 0.155 40.3)";

/** A one-colour asset drawn in the text colour, so it follows the theme. */
function Mark({ src, width, height }: { src: string; width: number; height: number }) {
  return (
    <Box
      aria-hidden
      sx={{
        width,
        height,
        flexShrink: 0,
        backgroundColor: "currentColor",
        mask: `url(${src}) center / contain no-repeat`,
      }}
    />
  );
}

const CARD_SX: SxProps<Theme> = {
  display: "flex",
  alignItems: "center",
  gap: "14px",
  width: "100%",
  p: 2,
  borderRadius: "16px",
  borderWidth: "1px",
  borderStyle: "solid",
  color: "text.primary",
  font: "inherit",
  textAlign: "left",
  textDecoration: "none",
  cursor: "pointer",
  "&:focus-visible": { outline: "2px solid var(--sw-ring)", outlineOffset: 2 },
};

function CardText({ title, description }: { title: string; description: string }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography sx={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.32px", lineHeight: 1.5 }}>
        {title}
      </Typography>
      <Typography
        sx={{
          fontSize: "0.8125rem",
          fontWeight: 500,
          letterSpacing: "-0.26px",
          lineHeight: 1.4,
          color: "color-mix(in oklch, var(--sw-foreground) 70%, transparent)",
        }}
      >
        {description}
      </Typography>
    </Box>
  );
}

/** The product badge at the head of the top bar: says this is Switch Rooms,
 *  and opens a panel to go to Switch Trust, in a new tab. */
export default function ProductSwitcher() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <Box
        component="button"
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          height: 32,
          px: "10px",
          py: "4px",
          flexShrink: 0,
          border: "none",
          borderRadius: "12px",
          backgroundColor: "color-mix(in oklch, var(--sw-card) 60%, transparent)",
          color: "text.primary",
          font: "inherit",
          cursor: "pointer",
          "&:hover": { backgroundColor: "var(--sw-card)" },
          "&:focus-visible": { outline: "2px solid var(--sw-ring)", outlineOffset: 2 },
        }}
      >
        <Mark src="/switch_badge_mark.svg" width={18} height={18} />
        <Box aria-hidden sx={{ width: "1px", height: 12, backgroundColor: "var(--sw-border)" }} />
        <Typography
          component="span"
          sx={{ fontSize: "0.9375rem", fontWeight: 700, lineHeight: "24px", letterSpacing: "-0.3px" }}
        >
          Rooms
        </Typography>
        <ExpandMoreOutlined aria-hidden sx={{ fontSize: 16, ml: "-4px" }} />
      </Box>

      <Popover
        open={open}
        anchorEl={trigger.current}
        marginThreshold={8}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{
          paper: {
            role: "menu",
            "aria-label": "Switch product",
            sx: {
              mt: 1,
              width: 286,
              p: 2,
              display: "flex",
              flexDirection: "column",
              gap: 2,
              borderRadius: "16px",
              backgroundColor: "var(--sw-popover)",
              color: "text.primary",
              backgroundImage: "none",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 1px 12px rgba(0,0,0,0.1)",
            },
          },
        }}
      >
        <Box role="img" aria-label="Switch AI" sx={{ display: "flex" }}>
          <Mark src="/switch_ai_wordmark.svg" width={86} height={14} />
        </Box>
        <Stack sx={{ gap: 1 }}>
          <Box
            component="button"
            type="button"
            role="menuitemradio"
            aria-checked
            onClick={close}
            sx={{
              ...CARD_SX,
              borderColor: "var(--sw-brand-blue)",
              background:
                "radial-gradient(ellipse 120% 150% at 100% 100%, color-mix(in oklch, var(--sw-brand-blue) 40%, transparent), color-mix(in oklch, var(--sw-card) 20%, transparent) 70%)",
            }}
          >
            <CardText title="Rooms" description="Put your team and any agents in one shared room" />
            <CheckOutlined aria-hidden sx={{ fontSize: 20 }} />
          </Box>
          <Box
            component="a"
            role="menuitemradio"
            aria-checked={false}
            href={TRUST_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
            sx={{
              ...CARD_SX,
              borderColor: "var(--sw-field-border)",
              background: `radial-gradient(ellipse 120% 150% at 100% 100%, color-mix(in oklch, ${VIGILANT_FLAME} 20%, transparent), color-mix(in oklch, var(--sw-brand-flame) 20%, transparent) 35%, color-mix(in oklch, var(--sw-card) 20%, transparent) 70%)`,
              "&:hover": { borderColor: "var(--sw-field-border-hover)" },
            }}
          >
            <CardText title="Trust" description="Scan agents for issues and track what they cost and deliver" />
          </Box>
        </Stack>
      </Popover>
    </>
  );
}
