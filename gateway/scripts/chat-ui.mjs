/* How the dashboard builds Switch's shared chat UI (`console/packages/chat-ui`),
 * which it compiles from source rather than installing.
 *
 * The package sits outside this directory, so its imports of React, mobx and
 * the rest would otherwise be looked for beside it, in Console's own
 * `node_modules`, which a dashboard build does not have. `dedupe` resolves
 * them here instead, so there is one React and one mobx on the page. */
import { fileURLToPath } from "node:url";

export const CHAT_UI_SRC = fileURLToPath(
  new URL("../../console/packages/chat-ui/src", import.meta.url),
);

export const chatUiResolve = {
  alias: [{ find: /^@switch-console\/chat-ui\/(.*)$/, replacement: `${CHAT_UI_SRC}/$1` }],
  dedupe: [
    "react",
    "react-dom",
    "mobx",
    "mobx-react-lite",
    "zod",
    "lucide-react",
    "@base-ui/react",
    "class-variance-authority",
    "clsx",
    "tailwind-merge",
    "streamdown",
    "react-syntax-highlighter",
    "date-fns",
    "@tanstack/react-query",
  ],
};
