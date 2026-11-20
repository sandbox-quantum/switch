import { createElement, type ReactHTMLElement } from "react";

/**
 * The hover label of a node in a force-graph view.
 *
 * The graph library writes a string label into the page as HTML, and node
 * labels are names and descriptions anyone in the workspace (or an agent with
 * only its key) can set. So the label is always an element whose lines are its
 * text, never a string of markup.
 */
export function graphTooltip(
  ...lines: (string | null | undefined)[]
): ReactHTMLElement<HTMLDivElement> {
  return createElement(
    "div",
    { style: { whiteSpace: "pre-line" } },
    lines.filter((line): line is string => !!line).join("\n"),
  );
}
