import { readFileSync } from 'node:fs';

/**
 * What Bombadil's `trace.jsonl` says about the properties: one line per state
 * it captured, each listing the properties violated in that state. A property
 * stays violated once it is, so a violation is reported by its first state.
 */

/** The parts of a trace line the lane reads. */
interface TraceLine {
  timestamp: number;
  state: { url: string; screenshot: string };
  violations: { name: string; violation: unknown }[];
}

export interface PropertyViolation {
  name: string;
  /** How many states it was reported in. */
  states: number;
  /** Microseconds since the first state captured. */
  firstAtMicros: number;
  url: string;
  screenshot: string;
  /** The condition that failed, and the extracted values it failed on. */
  detail: string;
}

export interface TraceSummary {
  states: number;
  violations: Map<string, PropertyViolation>;
}

export function readTrace(file: string): TraceSummary {
  return summarizeTrace(readFileSync(file, 'utf8'));
}

export function summarizeTrace(raw: string): TraceSummary {
  const violations = new Map<string, PropertyViolation>();
  let states = 0;
  let start: number | null = null;
  for (const [index, text] of raw.split('\n').entries()) {
    if (text.trim() === '') continue;
    let line: TraceLine;
    try {
      line = JSON.parse(text) as TraceLine;
    } catch (error) {
      throw new Error(
        `trace line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    states += 1;
    start ??= line.timestamp;
    for (const { name, violation } of line.violations) {
      const seen = violations.get(name);
      if (seen !== undefined) {
        seen.states += 1;
        continue;
      }
      violations.set(name, {
        name,
        states: 1,
        firstAtMicros: line.timestamp - start,
        url: line.state.url,
        screenshot: line.state.screenshot,
        detail: describeViolation(violation),
      });
    }
  }
  return { states, violations };
}

/** A violation as Bombadil serializes it: one variant per formula that can fail. */
type Violation =
  | { False: { condition: string; snapshots: { name: string | null; value: unknown }[] } }
  | { Always: { violation: Violation } }
  | { Eventually: { subformula: unknown; reason: 'TestEnded' | { TimedOut: number } } }
  | { Implies: { right: Violation } }
  | { And: { left: Violation; right: Violation } }
  | { Or: { left: Violation; right: Violation } };

/**
 * The condition that was false, with the values it was false on, or the
 * formula an `eventually` was still waiting for. Bombadil wraps a violation
 * once per operator around it, and both sides of an `and` or `or`.
 */
export function describeViolation(raw: unknown): string {
  const violation = raw as Violation;
  if ('False' in violation) {
    const { condition, snapshots } = violation.False;
    const values = snapshots
      .map((snapshot) => `${snapshot.name ?? '?'} = ${JSON.stringify(snapshot.value)}`)
      .join('; ');
    return values === '' ? condition : `${condition}, with ${values}`;
  }
  if ('Always' in violation) return describeViolation(violation.Always.violation);
  if ('Implies' in violation) return describeViolation(violation.Implies.right);
  if ('And' in violation) {
    return `${describeViolation(violation.And.left)} and ${describeViolation(violation.And.right)}`;
  }
  if ('Or' in violation) {
    const [left, right] = [violation.Or.left, violation.Or.right].map(describeViolation);
    return `neither ${left} nor ${right}`;
  }
  if ('Eventually' in violation) {
    const { subformula, reason } = violation.Eventually;
    const why = reason === 'TestEnded' ? 'by the end of the run' : 'within its time limit';
    return `never held ${why}: ${formulaText(subformula)}`;
  }
  throw new Error(`Unknown violation in the trace: ${JSON.stringify(raw).slice(0, 300)}`);
}

/** A formula as Bombadil serializes it, written back the way a specification writes it. */
function formulaText(raw: unknown): string {
  const formula = raw as Record<string, unknown>;
  if ('Thunk' in formula) return (formula.Thunk as { function: string }).function;
  if ('Pure' in formula) return (formula.Pure as { pretty: string }).pretty;
  for (const operator of ['And', 'Or', 'Implies'] as const) {
    if (operator in formula) {
      const [left, right] = formula[operator] as [unknown, unknown];
      return `(${formulaText(left)}) ${operator.toLowerCase()} (${formulaText(right)})`;
    }
  }
  for (const operator of ['Next', 'Always', 'Eventually'] as const) {
    if (operator in formula) {
      const inner = formula[operator];
      return `${operator.toLowerCase()}(${formulaText(Array.isArray(inner) ? inner[0] : inner)})`;
    }
  }
  throw new Error(`Unknown formula in the trace: ${JSON.stringify(raw).slice(0, 300)}`);
}
