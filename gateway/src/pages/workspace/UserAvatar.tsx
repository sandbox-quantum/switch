import { Box } from "@mui/material";

/** The first letters of a person's first two names ("Ada Lovelace" → "AL"),
 * or their email's first letter when they have no name. */
export function initialsOf(name: string, email: string): string {
  const fromName = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("");
  return (fromName || email.charAt(0) || "?").toUpperCase();
}

/** A person's initials in a small ink circle, beside their name in a users
 * table. Hidden from screen readers: the name beside it says it all. */
export default function UserAvatar({ name, email }: { name: string; email: string }) {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        width: 28,
        height: 28,
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        backgroundColor: "primary.main",
        color: "primary.contrastText",
        fontSize: "0.75rem",
        fontWeight: 700,
        letterSpacing: "-0.02em",
      }}
    >
      {initialsOf(name, email)}
    </Box>
  );
}
