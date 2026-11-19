import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import UrlsValueForm from "./UrlsValueForm";

/** The form as a page holds it: the value kept above it, as parsed. */
function Holder({ initial }: { initial: Record<string, unknown> }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <UrlsValueForm value={value} onChange={setValue} disabled={false} helperText="Links" />
      <output data-testid="value">{JSON.stringify(value)}</output>
      <button type="button" onClick={() => setValue({})}>
        Reset
      </button>
    </>
  );
}

const box = () => screen.getByLabelText("URLs (one per line)") as HTMLTextAreaElement;

describe("UrlsValueForm", () => {
  afterEach(cleanup);

  it("keeps a new line as it is typed, so a second URL can follow", () => {
    render(<Holder initial={{ urls: ["https://a.example"] }} />);

    fireEvent.change(box(), { target: { value: "https://a.example\n" } });
    expect(box().value).toBe("https://a.example\n");
    fireEvent.change(box(), { target: { value: "https://a.example\nhttps://b.example" } });

    expect(screen.getByTestId("value").textContent).toBe(
      JSON.stringify({ urls: ["https://a.example", "https://b.example"] }),
    );
  });

  it("starts again when the value is replaced from outside", () => {
    render(<Holder initial={{ urls: ["https://a.example"] }} />);
    fireEvent.change(box(), { target: { value: "https://a.example\n" } });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(box().value).toBe("");
  });
});
