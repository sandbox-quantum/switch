import { fireEvent } from "@testing-library/react";

/** A click on the backdrop of the open shared dialog, as a person makes it. */
export function clickOutsideDialog() {
  const backdrop = document.querySelector('[data-slot="dialog-overlay"]')!;
  fireEvent.pointerDown(backdrop, { button: 0 });
  fireEvent.mouseDown(backdrop, { button: 0 });
  fireEvent.pointerUp(backdrop, { button: 0 });
  fireEvent.mouseUp(backdrop, { button: 0 });
  fireEvent.click(backdrop, { button: 0 });
}
