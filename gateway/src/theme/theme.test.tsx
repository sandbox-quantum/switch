import { Checkbox, FormControlLabel, Menu, MenuItem, Stack, Switch, TextField, ThemeProvider } from "@mui/material";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { APP_THEME, ELEVATION } from "./theme";

const labelled = (control: ReactElement, labelPlacement?: "start") =>
  render(
    <ThemeProvider theme={APP_THEME()}>
      <FormControlLabel control={control} label="Show owners" labelPlacement={labelPlacement} />
    </ThemeProvider>,
  ).container.querySelector(".MuiFormControlLabel-root") as HTMLElement;

describe("theme", () => {
  afterEach(() => cleanup());

  it("keeps a switch in line and its label clear of it", () => {
    const end = getComputedStyle(labelled(<Switch />));
    expect([end.marginLeft, end.gap]).toEqual(["0px", "8px"]);
    cleanup();

    const start = getComputedStyle(labelled(<Switch />, "start"));
    expect([start.marginRight, start.gap]).toEqual(["0px", "8px"]);
  });

  it("leaves a Stack's spacing before a switch's label in place", () => {
    const { container } = render(
      <ThemeProvider theme={APP_THEME()}>
        <Stack direction="row" spacing={1}>
          <TextField label="Name" />
          <FormControlLabel control={<Switch />} label="Exclusive" />
        </Stack>
      </ThemeProvider>,
    );
    const label = container.querySelector(".MuiFormControlLabel-root") as HTMLElement;

    // The Stack's own margin (jsdom leaves its spacing variable unresolved),
    // not the 0 a switch's label otherwise takes.
    expect(getComputedStyle(label).marginLeft).toBe("var(--mui-spacing)");
  });

  it("lifts a menu off the card it opens over", () => {
    render(
      <ThemeProvider theme={APP_THEME()}>
        <Menu open anchorEl={document.body}>
          <MenuItem>Rename</MenuItem>
        </Menu>
      </ThemeProvider>,
    );
    const paper = getComputedStyle(screen.getByRole("menu").closest(".MuiPaper-root") as HTMLElement);

    expect(paper.backgroundColor).toBe("var(--sw-popover)");
    expect(paper.boxShadow.replace(/,\s*/g, ", ")).toBe(ELEVATION.popover);
  });

  it("leaves a checkbox's label as MUI lays it out", () => {
    expect(getComputedStyle(labelled(<Checkbox />)).marginLeft).toBe("-11px");
  });
});
