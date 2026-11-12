import { Box, ButtonBase, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import BrandTile from "./BrandTile";

/** What every connector page knows about a connector, from the catalog. */
export interface CatalogueConnector {
  slug: string;
  name: string;
  category: string;
  description: string;
}

/**
 * One connector in a catalogue grid. The card is a shell with slots, not a
 * card with a mode: the workspace's settings page and the personal
 * Connectors page each compose their own badges, meta line and top-right
 * control (an availability switch, a connect button), and nothing on one can
 * start rendering the other's controls. Everything else is identical.
 *
 * With `onOpen` the whole card opens the connector's profile; without it the
 * card is not pressable and does not look it. `trailing` sits above the
 * card's hit area, so using it does not also open the profile.
 */
export default function ConnectorCard({
  connector,
  badges,
  meta,
  onOpen,
  trailing,
}: {
  connector: CatalogueConnector;
  badges?: ReactNode;
  /** One muted line under the description: the category, a vendor, a count. */
  meta?: ReactNode;
  onOpen?: () => void;
  trailing?: ReactNode;
}) {
  const body = (
    <>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          {connector.name}
        </Typography>
        {badges}
      </Stack>
      {/* Two lines, then it clamps: a card as tall as its description would
          make the grid ragged, and the full text is on the profile. */}
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 0.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
      >
        {connector.description}
      </Typography>
      {meta && (
        <Typography variant="caption" color="text.secondary" component="p" noWrap sx={{ mt: 1 }}>
          {meta}
        </Typography>
      )}
    </>
  );

  return (
    <Box
      sx={{
        position: "relative",
        display: "flex",
        alignItems: "flex-start",
        gap: 1.5,
        p: 2,
        border: "1px solid var(--sw-border)",
        borderRadius: "10px",
        backgroundColor: "var(--sw-card)",
        ...(onOpen && { transition: "background-color 150ms", "&:hover": { backgroundColor: "var(--sw-muted)" } }),
      }}
    >
      <BrandTile slug={connector.slug} name={connector.name} size={56} />
      <Stack direction="row" spacing={1.5} sx={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}>
        {onOpen ? (
          <ButtonBase
            onClick={onOpen}
            disableRipple
            sx={{
              flex: 1,
              minWidth: 0,
              display: "block",
              textAlign: "left",
              borderRadius: "4px",
              // The whole card is the hit area: the button is not positioned,
              // so this stretches to the card rather than to the button.
              position: "static",
              "&::after": { content: '""', position: "absolute", inset: 0, borderRadius: "10px" },
              // The focus ring goes round the card it opens, not the text.
              "&.Mui-focusVisible, &:focus-visible": { outline: "none" },
              "&.Mui-focusVisible::after, &:focus-visible::after": {
                outline: "2px solid var(--sw-ring)",
                outlineOffset: "2px",
              },
            }}
          >
            {body}
          </ButtonBase>
        ) : (
          <Box sx={{ flex: 1, minWidth: 0 }}>{body}</Box>
        )}
        {trailing && <Box sx={{ position: "relative", zIndex: 1, flexShrink: 0 }}>{trailing}</Box>}
      </Stack>
    </Box>
  );
}
