/**
 * Switch Console asking the agent controller it runs on this computer to
 * delete the decision model it downloaded, over the controller's IPC
 * channel. The controller stops its model server first if it runs, deletes
 * the weights and llama.cpp build, and answers with the same `id`: `error`
 * null once the files are gone, or why they are not.
 *
 * Console's side is `embedded-controller/decision-model.ts`, which repeats
 * the two kinds (it does not depend on this package): change both together.
 * Console reads no answer within 15 s as a controller too old to know them.
 */
export const DECISION_MODEL_REMOVE_KIND = 'switch-decision-model-remove';
export const DECISION_MODEL_REMOVED_KIND = 'switch-decision-model-removed';

export type DecisionModelRemoveRequest = { kind: typeof DECISION_MODEL_REMOVE_KIND; id: string };

export type DecisionModelRemoveReply = {
  kind: typeof DECISION_MODEL_REMOVED_KIND;
  id: string;
  error: string | null;
};

export function isDecisionModelRemoveRequest(raw: unknown): raw is DecisionModelRemoveRequest {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === DECISION_MODEL_REMOVE_KIND &&
    typeof (raw as { id?: unknown }).id === 'string'
  );
}

/**
 * Requests from whoever runs this controller to remove the downloaded
 * decision model. The controller serves them while it runs; a request with
 * nothing serving it fails rather than waiting.
 */
export class DecisionModelRemovals {
  private handler: (() => Promise<void>) | null = null;

  /** Serves requests with `handler` until the returned function is called. */
  serve(handler: () => Promise<void>): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  run(): Promise<void> {
    if (!this.handler) return Promise.reject(new Error('The controller is not running yet.'));
    return this.handler();
  }
}
