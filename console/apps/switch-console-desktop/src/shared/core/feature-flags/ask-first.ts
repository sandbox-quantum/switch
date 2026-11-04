import type { ServerFeatureFlags } from './feature-flags';

/**
 * The one rule for adding a machine without the person's click (B38, ask
 * first), for every caller: Add agent's turn-on, the buddy's enrolment and the
 * automatic move's repair. Only when the server's flags were actually read
 * (`readOk`: read, no error) and that same read says hosted agents v2 is off.
 * Unknown, a failed read, or v2 on: ask first, and the person's own button
 * still does it.
 */
export function addsWithoutAsking(readOk: boolean, hostedV2: boolean | null): boolean {
  return readOk && hostedV2 === false;
}

/** `addsWithoutAsking`, from one flags state (both values from the same read). */
export function flagsAddWithoutAsking(
  state: Pick<ServerFeatureFlags, 'fetchedAt' | 'error' | 'flags'>
): boolean {
  return addsWithoutAsking(
    state.fetchedAt !== null && state.error === null,
    state.flags.hosted_v2 === true
  );
}
