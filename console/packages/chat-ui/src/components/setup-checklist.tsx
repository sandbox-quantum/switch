import { Circle, CircleCheck } from 'lucide-react';
import { Spinner } from '../primitives/spinner';

/** Where one stage of a setup is: done, under way, or still to come. */
export type SetupStageState = 'done' | 'current' | 'next';

/**
 * A setup told as a few plain stages, each ticked, turning or waiting, under
 * its title, with a line beneath for when it is taking a while. The first
 * run's pages use it wherever Switch works on something the person only waits
 * for, so it reads the same in Console and on the web.
 */
export function SetupChecklist({
  title,
  stages,
  note,
}: {
  title: string;
  stages: readonly { label: string; state: SetupStageState }[];
  /** A line under the stages, or null. */
  note: string | null;
}) {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-4 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <ul className="flex flex-col gap-2.5 text-left" role="status" aria-label={title}>
        {stages.map(({ label, state }) => (
          <li
            key={label}
            data-state={state}
            className={
              state === 'next'
                ? 'flex items-center gap-2.5 text-sm text-foreground-muted'
                : 'flex items-center gap-2.5 text-sm text-foreground'
            }
          >
            {state === 'done' ? (
              <CircleCheck aria-hidden className="size-4 text-green-500" />
            ) : state === 'current' ? (
              <Spinner aria-hidden className="size-4" />
            ) : (
              <Circle aria-hidden className="size-4" />
            )}
            {label}
          </li>
        ))}
      </ul>
      {note && <p className="text-xs text-foreground-muted">{note}</p>}
    </div>
  );
}
