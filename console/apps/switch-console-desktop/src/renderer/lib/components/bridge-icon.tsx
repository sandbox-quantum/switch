import React from 'react';
import { coerceRawSvgContent } from '@renderer/utils/mcp-icon-data';

// Brand logos for collaboration bridges (Slack, Mattermost, …), keyed by the
// gateway's `bridge_type`. Unlike MCP icons these keep their own brand colors,
// so the SVG fills are preserved (only width/height are stripped so the markup
// scales to the requested size).
const svgs = import.meta.glob('../../../assets/images/bridges/*.svg', {
  query: '?raw',
  eager: true,
});

function keyFromPath(path: string): string {
  return path
    .split('/')
    .pop()!
    .replace(/\.\w+$/, '');
}

const svgByKey = new Map(
  Object.entries(svgs)
    .map(([p, d]) => [keyFromPath(p), coerceRawSvgContent(d)] as const)
    .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string')
);

/** Whether a brand icon exists for the given `bridge_type`. */
export function hasBridgeIcon(bridgeType: string | null | undefined): bridgeType is string {
  return !!bridgeType && svgByKey.has(bridgeType);
}

/** Strip authored width/height so the inline SVG fills the sized wrapper. */
function sizeInlineSvg(svg: string): string {
  return svg.replace(/\swidth="[^"]*"/g, '').replace(/\sheight="[^"]*"/g, '');
}

/**
 * The brand logo for a collaboration bridge, identified by its `bridge_type`
 * (e.g. `slack`, `mattermost`). Renders nothing when no icon is bundled for the
 * type — callers gate on {@link hasBridgeIcon} and fall back to a generic icon.
 */
export function BridgeIcon({
  bridgeType,
  size = 16,
  className,
}: {
  bridgeType: string;
  size?: number;
  className?: string;
}) {
  const svg = svgByKey.get(bridgeType);
  if (!svg) return null;
  return (
    <span
      className={className}
      style={{ width: size, height: size, display: 'inline-block' }}
      // Brand SVGs are bundled assets, not user input.
      dangerouslySetInnerHTML={{ __html: sizeInlineSvg(svg) }}
    />
  );
}
