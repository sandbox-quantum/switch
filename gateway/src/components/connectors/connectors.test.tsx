import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brandSvg, monogram } from "./brandMarks";
import BrandTile from "./BrandTile";
import CatalogueGrid from "./CatalogueGrid";
import ConnectorAvailability from "./ConnectorAvailability";
import ConnectorCard, { type CatalogueConnector } from "./ConnectorCard";

// Read through Vite rather than node:fs, which the gateway has no types for.
const catalog = import.meta.glob("../../../../core/switch_core/connections/catalog/*/connection.yaml");
const gatewayLogos = import.meta.glob<string>("../../assets/connections/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});
const consoleLogos = import.meta.glob<string>(
  "../../../../console/apps/switch-console-desktop/src/assets/images/connections/*.svg",
  { query: "?raw", import: "default", eager: true },
);

const catalogSlugs = Object.keys(catalog).map((path) => path.split("/").at(-2)!);
const byFile = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, svg]) => [path.split("/").pop()!, svg]));

describe("brand logos", () => {
  it("reads the catalog it checks against", () => {
    expect(catalogSlugs).toContain("github");
  });

  it.each(catalogSlugs)("%s has a logo", (slug: string) => {
    expect(brandSvg(slug)).toBeTruthy();
  });

  it("are the same files Console ships", () => {
    expect(Object.keys(consoleLogos).length).toBeGreaterThan(0);
    expect(byFile(gatewayLogos)).toEqual(byFile(consoleLogos));
  });

  it("are sized to their tile whatever their root tag looks like", () => {
    for (const slug of catalogSlugs) {
      expect(brandSvg(slug), slug).toMatch(/^<svg width="100%" height="100%"[\s>]/);
    }
  });

  it("give each tile's gradients their own ids, so two tiles for one connector both keep them", () => {
    const { container } = render(
      <>
        <BrandTile slug="canva" name="Canva" size={56} />
        <BrandTile slug="canva" name="Canva" size={56} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);

    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    for (const use of container.querySelectorAll("[fill^='url(#']")) {
      expect(ids).toContain(use.getAttribute("fill")!.slice(5, -1));
    }
  });

  it("fall back to initials for a service this build has no logo for", () => {
    expect(brandSvg("some-future-service")).toBeUndefined();
    expect(monogram("New Relic")).toBe("NR");
    expect(monogram("microsoft-365")).toBe("M");
  });
});

describe("BrandTile", () => {
  afterEach(() => cleanup());

  it("draws the logo, or the initials when there is none", () => {
    const { container, rerender } = render(<BrandTile slug="github" name="GitHub" size={56} />);
    expect(container.querySelector("svg")).toBeTruthy();

    rerender(<BrandTile slug="some-future-service" name="Future Service" size={56} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("FS");
  });
});

const github: CatalogueConnector = {
  slug: "github",
  name: "GitHub",
  category: "Code",
  description: "Read repositories, issues and pull requests.",
};
const notion: CatalogueConnector = {
  slug: "notion",
  name: "Notion",
  category: "Knowledge base",
  description: "Read and write Notion pages and databases.",
};

describe("ConnectorCard", () => {
  afterEach(() => cleanup());

  it("opens the profile from anywhere on the card, but not from its control", () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    render(
      <ConnectorCard
        connector={github}
        onOpen={onOpen}
        trailing={
          <button type="button" onClick={onToggle}>
            Connect
          </button>
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("is not a button without somewhere to open", () => {
    render(<ConnectorCard connector={github} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("CatalogueGrid", () => {
  afterEach(() => cleanup());

  function Harness() {
    const [query, setQuery] = useState("");
    return (
      <CatalogueGrid
        connectors={[github, notion]}
        query={query}
        onQueryChange={setQuery}
        emptyMessage="No connectors match that search."
        renderCard={(connector) => <ConnectorCard connector={connector} />}
      />
    );
  }

  // First in this block: React warns about a missing key once per component,
  // so after any other render of the grid it would stay quiet.
  it("keys each card itself, so a page's renderCard needs no key", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness />);

    expect(errors.mock.calls.filter(([message]) => String(message).includes('unique "key"'))).toEqual([]);
    errors.mockRestore();
  });

  it("searches names, categories and descriptions, and says when nothing matches", () => {
    render(<Harness />);
    const search = screen.getByLabelText("Search connectors");

    fireEvent.change(search, { target: { value: "knowledge" } });
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.getByText("Notion")).toBeTruthy();

    expect(screen.getByRole("status").textContent).toBe("1 of 2 connectors");

    fireEvent.change(search, { target: { value: "spreadsheets" } });
    expect(screen.getByRole("status").textContent).toBe("No connectors match that search.");
  });
});

describe("ConnectorAvailability", () => {
  afterEach(() => cleanup());

  it("gives someone who may change it the state and a switch named for what it controls", () => {
    const onChange = vi.fn();
    render(
      <ConnectorAvailability available connectorName="GitHub" scopeName="Acme" turnedOffBy={null} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "GitHub available in Acme" }));

    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("gives anyone else the state in words, with no switch at all", () => {
    render(
      <ConnectorAvailability available={false} connectorName="GitHub" scopeName="Acme" turnedOffBy={null} onChange={null} />,
    );

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getByText("GitHub is disabled in Acme.")).toBeTruthy();
  });

  it("says when the level above has it off, with no switch to fight it", () => {
    render(
      <ConnectorAvailability available connectorName="GitHub" scopeName="Acme" turnedOffBy="SandboxAQ" onChange={() => {}} />,
    );

    expect(screen.getByText("Off for SandboxAQ")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Enabled")).toBeNull();
  });
});
