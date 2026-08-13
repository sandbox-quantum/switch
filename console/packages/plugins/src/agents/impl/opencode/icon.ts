import type { AgentIconAsset } from '@switch-console/core/agents/plugins';

/**
 * The mark is 4:5 and full-bleed — it paints its own canvas edge to edge, where
 * the other agent icons are glyphs with their own whitespace. Rendered as
 * authored it both overflowed the icon box (its intrinsic `width`/`height` won
 * over the wrapper's size, which is only applied to the wrapping span) and read
 * far heavier than its neighbours. It is therefore placed on the square 24×24
 * viewBox the other icons use, sized to leave the same margin they have, with
 * no intrinsic dimensions of its own.
 */
const MARK = (frame: string, inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g transform="translate(4.8 3) scale(0.06)"><path d="M180 240H60V120H180V240Z" fill="${inner}"/><path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="${frame}"/></g></svg>`;

export const icon: AgentIconAsset = {
  kind: 'svg',
  alt: 'OpenCode CLI',
  variants: [
    {
      minSize: 0,
      light: MARK('#211E1E', '#CFCECD'),
      dark: MARK('#F1ECEC', '#4B4646'),
    },
  ],
};
