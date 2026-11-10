import { Box } from "@mui/material";

/** The Switch mark, in the ink the colour scheme calls for.
 *
 * Two assets rather than one recoloured mark: the swap is done in CSS off the
 * colour-scheme attribute so there is no flash on first paint, and a future
 * coloured logo drops in without rework. The file names describe the ink —
 * `dark` is the black mark, for the light theme. */
export default function SwitchLogo({ size }: { size: string }) {
  return (
    <>
      <Box
        component="img"
        src="/switch_logo_dark.svg"
        alt="Switch"
        sx={{
          width: size,
          height: size,
          '[data-mui-color-scheme="dark"] &': { display: "none" },
        }}
      />
      <Box
        component="img"
        src="/switch_logo_light.svg"
        alt=""
        aria-hidden
        sx={{
          width: size,
          height: size,
          display: "none",
          '[data-mui-color-scheme="dark"] &': { display: "block" },
        }}
      />
    </>
  );
}
