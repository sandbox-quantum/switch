import { icon as claude } from "@switch-console/provider-icons/claude";
import { icon as codex } from "@switch-console/provider-icons/codex";
import { icon as cursor } from "@switch-console/provider-icons/cursor";
import type { WebProvider } from "./onboarding";

const ICONS = { claude, codex, cursor } as const;

/** An AI provider's icon, the artwork Console's plugins carry, drawn as Console draws it. */
export function ProviderIcon({ provider, size }: { provider: WebProvider; size: number }) {
  const icon = ICONS[provider];
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
