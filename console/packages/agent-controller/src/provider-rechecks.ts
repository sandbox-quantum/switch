/**
 * Requests, from whoever runs this controller, to check every provider again
 * now rather than when its check goes stale. Switch Console sends one over the
 * IPC channel of the controller it runs on its own computer, after the user
 * has installed or signed in to a provider.
 *
 * The controller serves them while it runs; a request with nothing serving it
 * fails rather than waiting.
 */
/** A recheck asked for before the controller serves them (not connected to Switch yet). */
export class RechecksNotServing extends Error {
  override name = 'RechecksNotServing';
  constructor() {
    super('The controller is not connected to Switch yet.');
  }
}

export class ProviderRechecks {
  private handler: (() => Promise<void>) | null = null;

  /** Serves requests with `handler` until the returned function is called. */
  serve(handler: () => Promise<void>): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  run(): Promise<void> {
    if (!this.handler) return Promise.reject(new RechecksNotServing());
    return this.handler();
  }
}
