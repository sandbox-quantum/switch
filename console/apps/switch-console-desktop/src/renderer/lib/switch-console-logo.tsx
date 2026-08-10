// Wide enough for LOGO_TEXT at the size below in the widest system sans the
// font stack can resolve to. The <svg> viewport clips, so this must not be
// tightened without re-measuring — the wordmark would lose its outer glyphs.
export const NATURAL_WIDTH = 545;
export const NATURAL_HEIGHT = 70;

export const LOGO_TEXT = 'Switch Console';

export const LOGO_FONT_FAMILY =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// The wordmark is rendered as text rather than as baked-in glyph paths so it
// carries the product name with no upstream logo artwork.
export function SwitchConsoleLogo({
  className,
  height = NATURAL_HEIGHT,
  color = 'currentColor',
}: {
  className?: string;
  height?: number;
  color?: string;
}) {
  const width = (height / NATURAL_HEIGHT) * NATURAL_WIDTH;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${NATURAL_WIDTH} ${NATURAL_HEIGHT}`}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <text
        x={NATURAL_WIDTH / 2}
        y="50"
        textAnchor="middle"
        fontFamily={LOGO_FONT_FAMILY}
        fontSize="52"
        fontWeight="700"
        letterSpacing="-1.5"
        fill={color}
      >
        {LOGO_TEXT}
      </text>
    </svg>
  );
}
