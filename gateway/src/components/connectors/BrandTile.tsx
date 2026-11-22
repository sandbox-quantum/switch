import { Box } from "@mui/material";
import { useId } from "react";
import { brandSvg, MARK_COLOR, monogram } from "./brandMarks";

/**
 * A service's logo on a neutral tile: the one mark used anywhere a connector
 * is named, so its fill, radius and logo size cannot drift between pages. The
 * tile stays neutral, because a tile in the brand's own colour would make one
 * connector shout across a grid where all are equal. Radius and logo size
 * follow `size`, so a small tile in a table and a large one on a card are
 * visibly the same object. A service with no logo shows its initials.
 *
 * `logoUrl` is a logo to draw as an image instead, for marks this list does
 * not carry: a messaging platform's own, as Switch serves it. An image rather
 * than inline markup, because it is the server's markup, not ours.
 */
export default function BrandTile({
  slug,
  name,
  size,
  logoUrl,
}: {
  slug: string;
  name: string;
  size: number;
  logoUrl?: string | null;
}) {
  // A full-colour logo names its gradients by id, and an id must be unique
  // in the page, so each tile gives its copy's ids its own suffix: two tiles
  // for one connector would otherwise share, and lose, one gradient.
  const suffix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svg = brandSvg(slug)?.replace(/(id="|url\(#)([\w-]+)/g, `$1$2-${suffix}`);
  const color = MARK_COLOR[slug];
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--sw-border)",
        borderRadius: size >= 48 ? "12px" : "10px",
        backgroundColor: "var(--sw-muted)",
        color: "var(--sw-muted-foreground)",
        fontSize: Math.round(size * 0.36),
        fontWeight: 600,
      }}
    >
      {logoUrl ? (
        <Box
          component="img"
          src={logoUrl}
          alt=""
          sx={(theme) => ({
            width: Math.round(size * 0.5),
            height: Math.round(size * 0.5),
            display: "block",
            // A logo drawn in black alone would vanish into the dark tile, and
            // the server's markup cannot be recoloured as the marks above are.
            ...theme.applyStyles("dark", { filter: "drop-shadow(0 0 1px rgb(255 255 255 / 0.7))" }),
          })}
        />
      ) : svg ? (
        <Box
          sx={(theme) => ({
            width: Math.round(size * 0.5),
            height: Math.round(size * 0.5),
            display: "flex",
            ...(color && { color: color.light, ...theme.applyStyles("dark", { color: color.dark }) }),
          })}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        monogram(name)
      )}
    </Box>
  );
}
