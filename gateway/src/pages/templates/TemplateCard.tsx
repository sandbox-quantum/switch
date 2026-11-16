import GridViewOutlined from "@mui/icons-material/GridViewOutlined";
import LockOutlined from "@mui/icons-material/LockOutlined";
import MeetingRoomOutlined from "@mui/icons-material/MeetingRoomOutlined";
import SmartToyOutlined from "@mui/icons-material/SmartToyOutlined";
import { Box, Button, ButtonBase, Chip, Stack, Tooltip, Typography } from "@mui/material";
import type { ReactElement } from "react";
import RowActionsMenu, { type RowAction } from "../../components/RowActionsMenu";
import type { TemplateSummary } from "../../data/api";
import {
  type TemplateKind,
  createsLine,
  kindLabel,
  kindOf,
  lastUsed,
  ownerLabel,
  useCaseLabel,
} from "./templateRows";

/** One glyph per kind, wherever a template's kind is shown: the rail's
 * for agents and rooms. */
const KIND_ICON: Record<TemplateKind, ReactElement> = {
  agent: <SmartToyOutlined />,
  room: <MeetingRoomOutlined />,
  group: <GridViewOutlined />,
};

/** A template's kind as a small outlined badge with its glyph. */
export function TemplateKindChip({ template }: { template: Pick<TemplateSummary, "kind"> }) {
  const kind = kindOf(template);
  return <Chip size="small" variant="outlined" icon={KIND_ICON[kind]} label={kindLabel(kind)} />;
}

/** Use a template, or, where the server says a person should not
 * (`run_blocked_reason`), a greyed button that says why on hover and focus.
 * Greyed with `aria-disabled` rather than `disabled`, so it stays in the
 * focus order and the reason can be reached from the keyboard. */
export function UseTemplateButton({
  template,
  label,
  accessibleName,
  variant,
  onUse,
}: {
  template: TemplateSummary;
  label: string;
  /** What a screen reader announces: a card's "Use" names its template, as
   * a page of cards has one per template. */
  accessibleName: string;
  variant: "outlined" | "contained";
  onUse: () => void;
}) {
  const blocked = template.run_blocked_reason;
  // MUI's own disabled look, which `aria-disabled` does not bring with it.
  const resting = variant === "contained" ? "var(--sw-muted)" : "var(--sw-card)";
  const button = (
    <Button
      variant={variant}
      onClick={blocked === null ? onUse : undefined}
      aria-disabled={blocked !== null || undefined}
      aria-label={accessibleName}
      sx={
        blocked === null
          ? undefined
          : {
              color: "var(--sw-field-disabled-foreground)",
              backgroundColor: resting,
              boxShadow: "none",
              cursor: "default",
              "&:hover": { backgroundColor: resting, boxShadow: "none", filter: "none" },
            }
      }
    >
      {label}
    </Button>
  );
  return blocked === null ? (
    button
  ) : (
    <Tooltip title={blocked} describeChild>
      {button}
    </Tooltip>
  );
}

/**
 * One template in the library. The title is the card's one real button,
 * stretched over the whole card so a click anywhere opens the template;
 * Use and the "…" sit above that hit area, so pressing them does not also
 * open it, and nothing interactive is nested inside another.
 */
export default function TemplateCard({
  template,
  actions,
  onOpen,
  onUse,
}: {
  template: TemplateSummary;
  /** The "…" menu's items; none leaves the card without one. */
  actions: RowAction[];
  onOpen: () => void;
  onUse: () => void;
}) {
  const creates = createsLine(template);
  const used = lastUsed(template);

  return (
    <Box
      component="article"
      aria-label={template.name}
      sx={{
        position: "relative",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 1.5,
        p: 2,
        border: "1px solid var(--sw-border)",
        borderRadius: "10px",
        backgroundColor: "var(--sw-card)",
        transition: "background-color 150ms",
        "&:hover": { backgroundColor: "var(--sw-muted)" },
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
        <Typography component="h3" variant="body2" sx={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>
          <ButtonBase
            onClick={onOpen}
            disableRipple
            sx={{
              font: "inherit",
              textAlign: "left",
              borderRadius: "4px",
              // Not positioned, so the overlay below stretches to the card.
              position: "static",
              "&::after": { content: '""', position: "absolute", inset: 0, borderRadius: "10px" },
              // The focus ring goes round the card it opens, not the title.
              "&.Mui-focusVisible, &:focus-visible": { outline: "none" },
              "&.Mui-focusVisible::after, &:focus-visible::after": {
                outline: "2px solid var(--sw-ring)",
                outlineOffset: "2px",
              },
            }}
          >
            {template.name}
          </ButtonBase>
        </Typography>
        <Box sx={{ flexShrink: 0 }}>
          <TemplateKindChip template={template} />
        </Box>
      </Stack>

      {template.description && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {template.description}
        </Typography>
      )}

      <Stack direction="row" spacing={1.5} sx={{ mt: "auto", alignItems: "flex-end", justifyContent: "space-between" }}>
        <Stack spacing={1} sx={{ minWidth: 0 }}>
          {(template.use_case || template.read_visibility === "private") && (
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
              {template.use_case && (
                <Chip size="small" variant="outlined" label={useCaseLabel(template.use_case)} />
              )}
              {template.read_visibility === "private" && (
                <Chip size="small" variant="outlined" icon={<LockOutlined />} label="Private" />
              )}
            </Stack>
          )}
          {creates && (
            <Typography variant="caption" color="text.secondary" noWrap component="p">
              {creates}
            </Typography>
          )}
          {/* Whose it is, for the workspace's own: the official ones are
              Switch's, as their section already says. */}
          {!template.official && (
            <Typography variant="caption" color="text.secondary" noWrap component="p">
              {ownerLabel(template)}
              {used && (
                <>
                  {" · "}
                  {/* Above the card's hit area, so its hover title shows. */}
                  <Box
                    component="time"
                    dateTime={template.last_run_at ?? undefined}
                    title={used.title}
                    sx={{ position: "relative", zIndex: 1 }}
                  >
                    {used.text}
                  </Box>
                </>
              )}
            </Typography>
          )}
        </Stack>
        <Stack direction="row" spacing={0.5} sx={{ position: "relative", zIndex: 1, flexShrink: 0, alignItems: "center" }}>
          <RowActionsMenu label={`More actions for ${template.name}`} actions={actions} tabIndex={0} />
          <UseTemplateButton
            template={template}
            label="Use"
            accessibleName={`Use ${template.name}`}
            variant="outlined"
            onUse={onUse}
          />
        </Stack>
      </Stack>
    </Box>
  );
}
