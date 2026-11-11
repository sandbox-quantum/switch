/**
 * Word that a signed-in gateway call was refused with 401, so whatever shows
 * the server as signed in can check again.
 *
 * This is a hint, not a sign-out. Every 401 the gateway gives a session call
 * means the session is gone, but a hint costs nothing to get wrong: the window
 * answers it by asking `/auth/me` again, the same check that decides "signed
 * in" everywhere else, so only a refusal there shows the signed-out state.
 *
 * Kept free of Electron so the gateway client and its tests can import it; the
 * main process forwards it to the window ({@link bridgeSessionEndedToRenderer}).
 */
type Listener = (serverId: string) => void;

const listeners = new Set<Listener>();

export function onSessionEnded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function noteSessionEnded(serverId: string): void {
  for (const listener of listeners) listener(serverId);
}
