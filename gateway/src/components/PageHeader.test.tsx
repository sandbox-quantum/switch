import { Box, Button, Typography } from "@mui/material";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PageHeader from "./PageHeader";

describe("PageHeader", () => {
  afterEach(() => cleanup());

  it("renders the title, description and actions", () => {
    render(
      <PageHeader
        title={<Typography variant="h5">Devices</Typography>}
        description={<Typography variant="body2">The devices in this workspace.</Typography>}
        actions={<Button>Add device</Button>}
      />,
    );

    expect(screen.getByRole("heading", { name: "Devices" })).not.toBeNull();
    expect(screen.getByText("The devices in this workspace.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add device" })).not.toBeNull();
  });

  it("does not shrink the actions slot, and keeps its buttons on one line", () => {
    render(
      <PageHeader
        title={<Typography variant="h5">Devices</Typography>}
        actions={<Button>Add device</Button>}
      />,
    );

    const button = screen.getByRole("button", { name: "Add device" });
    const actionsRow = button.parentElement as HTMLElement;

    expect(getComputedStyle(actionsRow).flexShrink).toBe("0");
    expect(getComputedStyle(actionsRow).flexWrap).toBe("wrap");
    expect(getComputedStyle(button).whiteSpace).toBe("nowrap");
  });

  // jsdom lays nothing out, so this pins the styles that keep four actions
  // (Rooms with a selection) inside a 440px content area: the row may be no
  // wider than the header, so its buttons wrap onto more lines, each whole.
  it("keeps four actions within a narrow header, wrapping among themselves", () => {
    const names = ["Archive (3)", "Manage groups", "Graph view", "New room"];
    render(
      <Box sx={{ width: 440 }}>
        <PageHeader
          title={<Typography variant="h5">Rooms</Typography>}
          description={<Typography variant="body2">Every room in this workspace.</Typography>}
          actions={names.map((name) => (
            <Button key={name}>{name}</Button>
          ))}
        />
      </Box>,
    );

    const buttons = names.map((name) => screen.getByRole("button", { name }));
    const actionsRow = buttons[0].parentElement as HTMLElement;
    const header = actionsRow.parentElement as HTMLElement;

    expect(buttons.every((button) => button.parentElement === actionsRow)).toBe(true);
    expect(getComputedStyle(header).flexWrap).toBe("wrap");
    expect(getComputedStyle(actionsRow).maxWidth).toBe("100%");
    expect(getComputedStyle(actionsRow).flexWrap).toBe("wrap");
    for (const button of buttons) {
      expect(getComputedStyle(button).whiteSpace).toBe("nowrap");
    }
  });

  it("lets the text block shrink, so it wraps instead of forcing the row wider", () => {
    render(<PageHeader title={<Typography variant="h5">Devices</Typography>} />);

    const heading = screen.getByRole("heading", { name: "Devices" });
    const textBlock = heading.parentElement as HTMLElement;

    expect(getComputedStyle(textBlock).minWidth).toBe("0px");
  });
});
