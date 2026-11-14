import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import LinkedText from "./LinkedText";

afterEach(cleanup);

describe("LinkedText", () => {
  it("links each https address, leaving the punctuation after it as text", () => {
    const { container } = render(
      <LinkedText text="Delete it in GitHub: https://github.com/settings/personal-access-tokens." />,
    );
    const link = screen.getByRole("link", {
      name: "https://github.com/settings/personal-access-tokens",
    });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/settings/personal-access-tokens",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(container.textContent).toBe(
      "Delete it in GitHub: https://github.com/settings/personal-access-tokens.",
    );
  });

  it("leaves text with no address as it is", () => {
    render(<LinkedText text="GitHub is disconnected." />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("GitHub is disconnected.")).toBeTruthy();
  });
});
