/** The contents of `src/theme/tokens.ts` for the given `tokens.css`. */
export function generateTokens(css: string): string;

/** What `tokens.css` generates beside the checked-in `tokens.ts`. */
export function currentTokens(): { generated: string; checkedIn: string };
