/** The contents of `src/theme/hoot-tokens.ts` for the given `hoot.css`. */
export function generateTokens(css: string): string;

/** What `hoot.css` generates beside the checked-in `hoot-tokens.ts`. */
export function currentTokens(): { generated: string; checkedIn: string };
