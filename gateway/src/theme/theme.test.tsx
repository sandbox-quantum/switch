import { Checkbox, FormControlLabel, Switch, ThemeProvider } from "@mui/material";
import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { APP_THEME } from "./theme";

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

  it("leaves a checkbox's label as MUI lays it out", () => {
    expect(getComputedStyle(labelled(<Checkbox />)).marginLeft).toBe("-11px");
  });
});
