import { CircleAlert, CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { activityWhen, sinceLabel } from '@renderer/features/switch-servers/server-times';
import { PanelTabs } from '@renderer/lib/ui/panel-tabs';
import type {
  IsolationResult,
  SharedCloudMachine,
  SharedCloudOverview,
} from '@shared/core/shared-cloud/shared-cloud';
import {
  ADMIN_TABS,
  type AdminTab,
  gigabytes,
  isolationText,
  ROOM_BAND,
  sumKnown,
} from './shared-cloud-state';

/**
 * The shared cloud as an admin sees it, in five tabs.
 *
 * Machines are shared with other workspaces. A workspace admin sees their own
 * people and a rounded room band, never a machine-wide figure, because a
 * total less their own people would show how busy everyone else is. A Switch
 * operator also gets each machine; the server sends that block only to them.
 * A figure the server couldn't read says so, and is never shown as 0.
 */
export function SharedCloudAdmin({ overview }: { overview: SharedCloudOverview }) {
  const [tab, setTab] = useState<AdminTab>('overview');
  return (
    <div className="space-y-5">
      <PanelTabs compact value={tab} onChange={setTab} tabs={ADMIN_TABS} />
      {tab === 'overview' && <OverviewTab overview={overview} onOpen={setTab} />}
      {tab === 'users' && <PeopleTable overview={overview} />}
      {tab === 'machines' && <MachinesTab overview={overview} />}
      {tab === 'isolation' && <IsolationTab overview={overview} />}
      {tab === 'alerts' && <AlertsTab overview={overview} />}
    </div>
  );
}

function OverviewTab({
  overview,
  onOpen,
}: {
  overview: SharedCloudOverview;
  onOpen: (tab: AdminTab) => void;
}) {
  const { people, isolation, room } = overview;
  const now = new Date();
  const agentTotal = people.reduce(
    (sum, p) => sum + p.agents.working + p.agents.idle + p.agents.resting + p.agents.unavailable,
    0
  );
  const working = people.reduce((sum, p) => sum + p.agents.working, 0);
  const peopleMemory = sumKnown(people.map((p) => p.memory_bytes));
  const machines = overview.nodes?.machines ?? null;
  const shared = machines?.filter((m) => m.kind === 'shared') ?? [];
  const burst = machines?.filter((m) => m.kind === 'burst') ?? [];
  const nodeTotal = shared.reduce((sum, m) => sum + m.memory_total_bytes, 0);
  const nodeUsed = shared.reduce(
    (sum, m) => sum + m.memory_working_bytes + m.memory_resting_bytes + m.memory_system_bytes,
    0
  );
  const openAlerts = overview.alerts.filter((alert) => alert.cleared_at === null);

  return (
    <div className="space-y-5">
      {openAlerts.length > 0 && (
        <button
          type="button"
          onClick={() => onOpen('alerts')}
          className="flex w-full items-center gap-2 rounded-[11px] border border-[var(--red-4)] bg-[var(--red-3)] px-[14px] py-2.5 text-left text-sm"
        >
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-[var(--red-11)]" />
          <span>
            <span className="font-medium">{openAlerts[0]!.title}.</span>{' '}
            {openAlerts.length > 1 ? `And ${openAlerts.length - 1} more. ` : ''}See Alerts.
          </span>
        </button>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <Tile
          label="People"
          value={String(people.length)}
          note={`${agentTotal} ${agentTotal === 1 ? 'agent' : 'agents'} · ${working} working`}
        />
        {machines ? (
          <>
            <Tile
              label="Shared machines"
              value={String(shared.length)}
              note={
                burst.length > 0
                  ? `plus ${burst.length} for heavy builds`
                  : `${shared[0]?.instance_type ?? ''} · none for builds`
              }
            />
            <Tile
              label="Memory in use"
              value={nodeTotal > 0 ? `${Math.round((nodeUsed / nodeTotal) * 100)}%` : 'Unknown'}
              note={
                nodeTotal > 0
                  ? `${gigabytes(nodeUsed)} of ${gigabytes(nodeTotal)}`
                  : "can't reach the machines"
              }
              warn={nodeTotal === 0}
            />
          </>
        ) : (
          <>
            <Tile
              label="Memory, your people"
              value={peopleMemory === null ? 'Unknown' : gigabytes(peopleMemory)}
              note={peopleMemory === null ? "can't read it right now" : 'used by their agents now'}
              warn={peopleMemory === null}
            />
            <Tile
              label="Room"
              value={ROOM_BAND[room].label}
              note={ROOM_BAND[room].note}
              warn={room !== 'plenty'}
            />
          </>
        )}
        {/* The cost tile is parked: this view shows what production shows. */}
        <Tile
          label="Kept apart"
          value={
            isolation.result === 'unknown'
              ? 'Unknown'
              : isolation.result === 'fail'
                ? 'Failed'
                : `${isolation.blocked} of ${isolation.total}`
          }
          note={
            isolation.checked_at === null
              ? 'no check has run yet'
              : isolation.result === 'fail'
                ? `${isolation.total - isolation.blocked} got through · ${activityWhen(isolation.checked_at, now)}`
                : `blocked · checked ${activityWhen(isolation.checked_at, now)}`
          }
          icon={<IsolationIcon result={isolation.result} />}
          warn={isolation.result !== 'pass'}
        />
      </div>
      <PeopleTable overview={overview} />
    </div>
  );
}

function PeopleTable({ overview }: { overview: SharedCloudOverview }) {
  const { people } = overview;
  return (
    <section className="rounded-[11px] border border-border p-[14px]">
      <h2 className="mb-2 text-sm font-medium">People</h2>
      {people.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          Nobody in this workspace has agents on the shared cloud yet.
        </p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-foreground-muted">
              <th className="border-b border-border py-1.5 pr-2 font-medium">Person</th>
              <th className="border-b border-border py-1.5 pr-2 font-medium">Agents</th>
              <th className="border-b border-border py-1.5 pr-2 font-medium">Memory now</th>
              <th className="border-b border-border py-1.5 font-medium">Kept apart</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.user_id}>
                <td className="border-b border-border py-2 pr-2 font-medium">{person.name}</td>
                <td className="border-b border-border py-2 pr-2">
                  <div className="flex flex-wrap gap-1">
                    <Chip count={person.agents.working} label="working" tone="working" />
                    <Chip count={person.agents.idle} label="idle" tone="idle" />
                    <Chip count={person.agents.resting} label="resting" tone="resting" />
                    <Chip count={person.agents.unavailable} label="can't reply" tone="problem" />
                  </div>
                </td>
                <td className="border-b border-border py-2 pr-2">
                  {person.memory_bytes === null ? <Unknown /> : gigabytes(person.memory_bytes)}
                </td>
                <td className="border-b border-border py-2">
                  <span className="inline-flex items-center gap-1">
                    <IsolationIcon result={person.kept_apart} />
                    {isolationText(person.kept_apart)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-foreground-muted">
        &ldquo;Kept apart&rdquo; is the latest isolation check for that person: their agents, files
        and network can&apos;t reach anyone else&apos;s.
      </p>
    </section>
  );
}

function MachinesTab({ overview }: { overview: SharedCloudOverview }) {
  const machines = overview.nodes?.machines ?? null;
  if (machines === null) {
    const band = ROOM_BAND[overview.room];
    return (
      <section className="rounded-[11px] border border-border p-[14px] text-sm">
        <h2 className="mb-1 text-sm font-medium">Room for more agents: {band.label}</h2>
        <p className="text-foreground-muted">
          {overview.room === 'plenty'
            ? ''
            : `${band.note[0]!.toUpperCase()}${band.note.slice(1)}. `}
          Your people&apos;s agents share Switch&apos;s cloud machines with other workspaces, so the
          machines themselves aren&apos;t shown here. Switch adds machines as more people join, and
          starts one for a heavy build by itself.
        </p>
      </section>
    );
  }
  if (machines.length === 0)
    return <p className="text-sm text-foreground-muted">No shared machines are running.</p>;
  return (
    <div className="space-y-3">
      {machines.map((machine) => (
        <MachineCard key={machine.name} machine={machine} />
      ))}
      {!machines.some((m) => m.kind === 'burst') && (
        <p className="text-sm text-foreground-muted">
          No machines for heavy builds are running. One starts by itself for a heavy build and stops
          when it&apos;s done.
        </p>
      )}
    </div>
  );
}

function MachineCard({ machine }: { machine: SharedCloudMachine }) {
  return (
    <section className="rounded-[11px] border border-border p-[14px]">
      <h2 className="text-sm">
        <span className="font-medium">{machine.name}</span>
        <span className="text-foreground-muted">
          {' '}
          · {machine.instance_type} · {gigabytes(machine.memory_total_bytes)}
          {machine.kind === 'burst' ? ' · heavy builds' : ''}
        </span>
      </h2>
      <div className="mt-2">
        <MemoryBar
          total={machine.memory_total_bytes}
          working={machine.memory_working_bytes}
          resting={machine.memory_resting_bytes}
          system={machine.memory_system_bytes}
        />
      </div>
      <p className="mt-2 text-sm text-foreground-muted">
        {machine.people} {machine.people === 1 ? 'person' : 'people'} ·{' '}
        {machine.room_for_people === null
          ? 'not enough measured yet to say how many more fit'
          : `room for about ${machine.room_for_people} more at today's resting memory`}
      </p>
    </section>
  );
}

function IsolationTab({ overview }: { overview: SharedCloudOverview }) {
  const { isolation } = overview;
  if (isolation.checked_at === null || isolation.attempts.length === 0)
    return (
      <p className="text-sm text-foreground-muted">
        No isolation check has run yet, or its result can&apos;t be read right now.
      </p>
    );
  const directions = isolation.attempts[0]!.results.map((r) => r.direction);
  return (
    <section className="rounded-[11px] border border-border p-[14px]">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <IsolationIcon result={isolation.result} />
        {isolation.result === 'pass'
          ? `All ${isolation.total} attempts were blocked`
          : isolation.result === 'fail'
            ? `${isolation.total - isolation.blocked} of ${isolation.total} attempts got through`
            : 'The latest result is unknown'}
      </h2>
      <p className="mb-3 text-xs text-foreground-muted">
        Checked {sinceLabel(isolation.checked_at, new Date())}. Each person&apos;s agents tried to
        reach the other person&apos;s, in both directions.
      </p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-foreground-muted">
            <th className="border-b border-border py-1.5 pr-2 font-medium">Attempt</th>
            {directions.map((direction) => (
              <th key={direction} className="border-b border-border py-1.5 pr-2 font-medium">
                {direction}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isolation.attempts.map((attempt) => (
            <tr key={attempt.label}>
              <td className="border-b border-border py-2 pr-2">{attempt.label}</td>
              {attempt.results.map((r) => (
                <td key={r.direction} className="border-b border-border py-2 pr-2">
                  <span className="inline-flex items-center gap-1">
                    <IsolationIcon result={r.result} />
                    {r.result === 'pass'
                      ? 'Blocked'
                      : r.result === 'fail'
                        ? 'Got through'
                        : 'Unknown'}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const WEEK = 7 * 24 * 60 * 60 * 1000;

function AlertsTab({ overview }: { overview: SharedCloudOverview }) {
  const now = new Date();
  const open = overview.alerts.filter((a) => a.cleared_at === null);
  const cleared = overview.alerts.filter(
    (a) => a.cleared_at !== null && now.getTime() - new Date(a.cleared_at).getTime() < WEEK
  );
  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 text-sm font-medium">Now</h2>
        {open.length === 0 ? (
          <p className="text-sm text-foreground-muted">Nothing needs your attention.</p>
        ) : (
          <ul className="space-y-2">
            {open.map((alert) => (
              <AlertRow key={alert.id} alert={alert} now={now} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-sm font-medium">Cleared in the last 7 days</h2>
        {cleared.length === 0 ? (
          <p className="text-sm text-foreground-muted">None.</p>
        ) : (
          <ul className="space-y-2">
            {cleared.map((alert) => (
              <AlertRow key={alert.id} alert={alert} now={now} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AlertRow({ alert, now }: { alert: SharedCloudOverview['alerts'][number]; now: Date }) {
  const live = alert.cleared_at === null;
  return (
    <li className="flex gap-2 rounded-[11px] border border-border px-[14px] py-2.5 text-sm">
      {live ? (
        <TriangleAlert
          aria-label={alert.severity === 'critical' ? 'Critical' : 'Warning'}
          className={`mt-[2px] size-4 shrink-0 ${alert.severity === 'critical' ? 'text-destructive' : 'text-foreground-warning'}`}
        />
      ) : (
        <CircleCheck
          aria-label="Cleared"
          className="mt-[2px] size-4 shrink-0 text-[var(--green-11)]"
        />
      )}
      <div>
        <p className="font-medium">{alert.title}</p>
        <p className="text-foreground-muted">{alert.detail}</p>
        <p className="text-xs text-foreground-tertiary-passive">
          Raised {sinceLabel(alert.raised_at, now)}
          {alert.cleared_at ? ` · cleared ${sinceLabel(alert.cleared_at, now)}` : ''}
        </p>
      </div>
    </li>
  );
}

function Tile({
  label,
  value,
  note,
  icon,
  warn = false,
}: {
  label: string;
  value: string;
  note: string;
  icon?: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div className="rounded-[11px] border border-border px-[14px] py-3">
      <p className="text-xs font-medium text-foreground-muted">{label}</p>
      <p
        className={`mt-1 flex items-center gap-1.5 font-semibold text-foreground ${value.length > 6 ? 'text-xl' : 'text-2xl'}`}
      >
        {icon}
        {value}
      </p>
      <p className={`text-xs ${warn ? 'text-foreground-warning' : 'text-foreground-muted'}`}>
        {note}
      </p>
    </div>
  );
}

function Unknown() {
  return <span className="text-foreground-muted">Unknown</span>;
}

const CHIP = {
  working: 'bg-[var(--green-3)] text-[var(--green-11)]',
  idle: 'bg-[var(--blue-3)] text-[var(--blue-11)]',
  resting: 'bg-[var(--neutral-3)] text-[var(--neutral-11)]',
  problem: 'bg-[var(--red-3)] text-[var(--red-11)]',
} as const;

function Chip({ count, label, tone }: { count: number; label: string; tone: keyof typeof CHIP }) {
  if (count === 0) return null;
  return (
    <span className={`rounded-full px-2 py-px text-xs ${CHIP[tone]}`}>
      {count} {label}
    </span>
  );
}

function IsolationIcon({ result }: { result: IsolationResult }) {
  if (result === 'pass')
    return <CircleCheck aria-hidden className="size-[1em] shrink-0 text-[var(--green-11)]" />;
  if (result === 'fail')
    return <CircleAlert aria-hidden className="size-[1em] shrink-0 text-destructive" />;
  return <CircleHelp aria-hidden className="size-[1em] shrink-0 text-foreground-muted" />;
}

function MemoryBar({
  total,
  working,
  resting,
  system,
}: {
  total: number;
  working: number;
  resting: number;
  system: number;
}) {
  const pct = (bytes: number) => (total > 0 ? `${(bytes / total) * 100}%` : '0%');
  const free = Math.max(0, total - working - resting - system);
  return (
    <div>
      <div
        className="flex h-3.5 overflow-hidden rounded-[5px] bg-[var(--fill)]"
        role="img"
        aria-label={`Memory: ${gigabytes(working)} working, ${gigabytes(resting)} resting, ${gigabytes(system)} system, ${gigabytes(free)} free`}
      >
        <i className="block h-full bg-[var(--blue-9)]" style={{ width: pct(working) }} />
        <i className="block h-full bg-[var(--blue-4)]" style={{ width: pct(resting) }} />
        <i className="block h-full bg-[var(--neutral-9)]" style={{ width: pct(system) }} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-foreground-muted">
        <Legend swatch="bg-[var(--blue-9)]" text={`Working ${gigabytes(working)}`} />
        <Legend swatch="bg-[var(--blue-4)]" text={`Resting ${gigabytes(resting)}`} />
        <Legend swatch="bg-[var(--neutral-9)]" text={`System ${gigabytes(system)}`} />
        <span>Free {gigabytes(free)}</span>
      </div>
    </div>
  );
}

function Legend({ swatch, text }: { swatch: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className={`inline-block size-2.5 rounded-[3px] ${swatch}`} />
      {text}
    </span>
  );
}
