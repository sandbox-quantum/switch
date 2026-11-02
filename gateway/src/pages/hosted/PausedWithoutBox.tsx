import { Stack, Typography } from "@mui/material";
import BoxActions from "./BoxActions";
import { groupedId } from "./hostedActions";

// Copy doc 19fe1257, W6.
export const HEADING = "Paused users with no box";
export const LINE =
  "These users are paused but have no box right now, so they aren't in the table above.";

interface Person {
  user_id: string;
  paused: boolean;
}

interface Box {
  user: string;
}

interface Props {
  /** V4 overview's `people` and `boxes`, as W4 already reads them. */
  people: readonly Person[];
  boxes: readonly Box[];
  /** Called after Resume is accepted, so the overview reloads. */
  onDone: () => void;
}

/** W6: a paused person with no box shows in no Boxes row, so Resume would be
 *  out of reach. This lists them, each with Resume through the same dialog.
 *  Shows nothing when there's no one. Keyed ids only. W4 places it under its
 *  Boxes table. */
export default function PausedWithoutBox({ people, boxes, onDone }: Props) {
  const withBox = new Set(boxes.map((b) => b.user));
  const waiting = people.filter((p) => p.paused && !withBox.has(p.user_id));
  if (waiting.length === 0) return null;
  return (
    <Stack component="section" aria-label={HEADING} spacing={1} sx={{ mt: 3 }}>
      <Typography variant="subtitle1" component="h2">
        {HEADING}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {LINE}
      </Typography>
      {waiting.map((person) => (
        <Stack
          key={person.user_id}
          direction="row"
          spacing={2}
          alignItems="center"
          data-testid="paused-without-box"
        >
          <Typography sx={{ fontFamily: "monospace", minWidth: 180 }}>
            {groupedId(person.user_id)}
          </Typography>
          <BoxActions
            userKeyedId={person.user_id}
            boxKeyedId={null}
            paused
            running={false}
            onDone={onDone}
          />
        </Stack>
      ))}
    </Stack>
  );
}
