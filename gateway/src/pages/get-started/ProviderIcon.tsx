import { icon as antigravity } from "@switch-console/provider-icons/antigravity";
import { icon as claude } from "@switch-console/provider-icons/claude";
import { icon as cline } from "@switch-console/provider-icons/cline";
import { icon as codex } from "@switch-console/provider-icons/codex";
import { icon as copilot } from "@switch-console/provider-icons/copilot";
import { icon as cursor } from "@switch-console/provider-icons/cursor";
import { icon as deepseekHarness } from "@switch-console/provider-icons/deepseek-harness";
import { icon as droid } from "@switch-console/provider-icons/droid";
import { icon as goose } from "@switch-console/provider-icons/goose";
import { icon as junie } from "@switch-console/provider-icons/junie";
import { icon as kiro } from "@switch-console/provider-icons/kiro";
import { icon as mistralVibe } from "@switch-console/provider-icons/mistral-vibe";
import { icon as opencode } from "@switch-console/provider-icons/opencode";
import { icon as pi } from "@switch-console/provider-icons/pi";
import { icon as qwen } from "@switch-console/provider-icons/qwen";

const ICONS: Record<string, typeof claude> = {
  antigravity,
  claude,
  cline,
  codex,
  copilot,
  cursor,
  "deepseek-harness": deepseekHarness,
  droid,
  goose,
  junie,
  kiro,
  "mistral-vibe": mistralVibe,
  opencode,
  pi,
  qwen,
};

/** An AI provider's icon, the artwork Console's plugins carry, drawn as Console draws it; nothing for one it has none for. */
export function ProviderIcon({ provider, size }: { provider: string; size: number }) {
  const icon = ICONS[provider];
  if (!icon) return null;
  const variant =
    [...icon.variants].sort((a, b) => b.minSize - a.minSize).find((v) => v.minSize <= size) ??
    icon.variants[0]!;
  const className = `inline-flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full${
    icon.invertInDark && !variant.dark ? " dark:invert" : ""
  }`;
  if (icon.kind === "image")
    return (
      <span className={className} style={{ width: size, height: size }}>
        <img src={variant.light} alt={icon.alt ?? provider} width={size} height={size} />
      </span>
    );
  return (
    <span
      className={className}
      style={{ width: size, height: size }}
      role="img"
      aria-label={icon.alt ?? provider}
      // The plugins' own artwork, shipped with Switch.
      dangerouslySetInnerHTML={{ __html: variant.light }}
    />
  );
}
