import { Box } from "@mui/material";
import { Fragment } from "react";

/** Core writes ids in an alert's title between backticks (for the ops room).
 *  Here they show in a fixed-width font, as plain text, never as markup. */
export default function AlertTitle({ title }: { title: string }) {
  const parts = title.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Box component="code" key={i} sx={{ fontFamily: "monospace" }}>
            {part}
          </Box>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
