import { describe, expect, it } from "vitest";
import { opensLink } from "./FileMarkdown";

describe("opensLink", () => {
  it("opens https only", () => {
    expect(opensLink("https://example.com/docs")).toBe(true);
    expect(opensLink("  HTTPS://example.com")).toBe(true);
    for (const href of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "../secrets", "", undefined, 7])
      expect(opensLink(href)).toBe(false);
  });
});
