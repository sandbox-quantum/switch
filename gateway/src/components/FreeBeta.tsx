import CheckOutlined from "@mui/icons-material/CheckOutlined";
import CloseOutlined from "@mui/icons-material/CloseOutlined";
import { Box, Dialog, IconButton, Stack, Typography } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import { useId, useState } from "react";

const PERKS = [
  "A free cloud device to host your agents",
  "Unlimited rooms",
  "Free until 18 Feb 2027",
  "Self-hosting version is open source",
];

/** One of the hero's characters: its art centred in a box and turned. */
const CHARACTERS = [
  { src: "/free-beta/blob-round.svg", box: [106.687, 105.008], at: [81, 95], art: [83, 80], turn: -21.69 },
  { src: "/free-beta/blob-triangle.svg", box: [83.394, 83.394], at: [198, 43], art: [73, 73], turn: -8.88 },
  { src: "/free-beta/blob-square.svg", box: [103.729, 82.512], at: [267, 136], art: [91.027, 61], turn: 15.02 },
] as const;

// The sky fades into the card along an eased curve rather than a straight
// ramp, so its top edge can't be seen.
const FADE = `linear-gradient(to top, ${[
  [100, 0],
  [100, 25],
  [96, 38],
  [86, 50],
  [70, 61],
  [50, 72],
  [30, 82],
  [14, 90],
  [4, 96],
  [0, 100],
]
  .map(([mix, at]) => `color-mix(in oklch, var(--sw-card) ${mix}%, transparent) ${at}%`)
  .join(", ")})`;

const TEXT = { fontSize: "0.8125rem", lineHeight: "18px", color: "text.primary" };

function Hero() {
  return (
    <Box aria-hidden sx={{ position: "relative", height: 240, overflow: "hidden" }}>
      <Box
        component="img"
        src="/free-beta/sky.webp"
        alt=""
        sx={{
          position: "absolute",
          left: -11,
          top: -24,
          // The top half of the artwork: the hero never shows more.
          width: 557,
          height: 538.5,
          maxWidth: "none",
          objectFit: "cover",
          opacity: 0.8,
          filter: "blur(6px)",
        }}
      />
      <Box
        sx={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 200,
          background: FADE,
        }}
      />
      {CHARACTERS.map(({ src, box, at, art, turn }) => (
        <Box
          key={src}
          sx={{
            position: "absolute",
            left: at[0],
            top: at[1],
            width: box[0],
            height: box[1],
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Box
            component="img"
            src={src}
            alt=""
            sx={{ width: art[0], height: art[1], flexShrink: 0, transform: `rotate(${turn}deg)` }}
          />
        </Box>
      ))}
    </Box>
  );
}

/** The Switch-blue pill the Free Beta is named in. */
const PILL_SX: SxProps<Theme> = {
  px: 1,
  py: "2px",
  borderRadius: "999px",
  border: "1px solid var(--sw-brand-blue)",
  backgroundColor: "color-mix(in oklch, var(--sw-brand-blue) 40%, transparent)",
  color: "oklch(0.360 0.060 212.9)",
  fontFamily: "inherit",
  fontSize: "0.75rem",
  fontWeight: 500,
  lineHeight: "16px",
  // The light theme's deep blue ink is unreadable on the dark card.
  '[data-mui-color-scheme="dark"] &': {
    backgroundColor: "color-mix(in oklch, var(--sw-brand-blue) 20%, transparent)",
    color: "var(--sw-brand-blue)",
  },
};

const CARD_SX: SxProps<Theme> = {
  width: 480,
  maxWidth: "100%",
  borderRadius: "16px",
  backgroundColor: "var(--sw-card)",
  overflow: "hidden",
};

/** The Free Beta's sky, characters and copy: the body of both its card and
 *  its dialog, so the two can't drift. */
function FreeBetaContent({ titleId }: { titleId: string }) {
  return (
    <>
      <Hero />
      <Stack sx={{ px: 5, pb: 5, gap: 3 }}>
        <Stack sx={{ alignItems: "flex-start", gap: 2 }}>
          <Box component="span" sx={PILL_SX}>
            Free Beta for Switch Cloud
          </Box>
          <Typography
            id={titleId}
            component="h2"
            sx={{ fontSize: "23px", fontWeight: 500, lineHeight: 1.25, letterSpacing: "-0.02em", color: "text.primary" }}
          >
            Build your human-agent hybrid team now.
          </Typography>
          <Typography sx={TEXT}>
            To accelerate your AI-native transformation, you can host your agents on Switch Cloud for free now.
          </Typography>
        </Stack>
        <Stack component="ul" sx={{ gap: 2, m: 0, p: 0, listStyle: "none" }}>
          {PERKS.map((perk) => (
            <Box component="li" key={perk} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <CheckOutlined aria-hidden sx={{ fontSize: 16, color: "var(--sw-success)" }} />
              <Typography component="span" sx={TEXT}>
                {perk}
              </Typography>
            </Box>
          ))}
        </Stack>
      </Stack>
    </>
  );
}

/** What the Free Beta offers on Switch Cloud, as a card. */
export function FreeBetaPanel() {
  const titleId = useId();
  return (
    <Box component="section" aria-labelledby={titleId} sx={{ ...CARD_SX, border: "1px solid var(--sw-border)" }}>
      <FreeBetaContent titleId={titleId} />
    </Box>
  );
}

/** The top bar's "Free Beta" pill, which opens what the beta offers. */
export function FreeBetaButton() {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Box
        component="button"
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        sx={{
          ...PILL_SX,
          cursor: "pointer",
          "&:hover": { backgroundColor: "color-mix(in oklch, var(--sw-brand-blue) 55%, transparent)" },
          "&:focus-visible": { outline: "2px solid var(--sw-ring)", outlineOffset: 2 },
        }}
      >
        Free Beta
      </Box>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        aria-labelledby={titleId}
        slotProps={{ paper: { sx: { ...CARD_SX, m: 2, position: "relative", backgroundImage: "none" } } }}
      >
        <FreeBetaContent titleId={titleId} />
        <IconButton
          aria-label="Close"
          onClick={() => setOpen(false)}
          sx={{
            position: "absolute",
            top: 16,
            right: 16,
            width: 32,
            height: 32,
            color: "text.primary",
            backgroundColor: "color-mix(in oklch, var(--sw-card) 80%, transparent)",
            "&:hover": { backgroundColor: "var(--sw-card)" },
          }}
        >
          <CloseOutlined sx={{ fontSize: 18 }} />
        </IconButton>
      </Dialog>
    </>
  );
}
