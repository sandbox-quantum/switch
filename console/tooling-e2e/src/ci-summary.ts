/**
 * Turn a run's JUnit report into the CI run summary: a Markdown table of the
 * end-to-end scenarios for the job page, and one line for the scheduled-run
 * notification.
 *
 *     node --experimental-strip-types src/ci-summary.ts <junit.xml> <lane> <title>
 *
 * Prints the Markdown to stdout. Under GitHub Actions it also writes `line=` to
 * `$GITHUB_OUTPUT`. A missing report is an error: a lane that wrote none did not
 * get as far as its suite, and a summary that read "0 passed" would hide that.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { isLane, LANES, type Lane } from './core/env.ts';
import { message } from './core/suite.ts';

export type CaseStatus = 'pass' | 'fail' | 'skip';

export interface ScenarioCase {
  file: string;
  name: string;
  seconds: number;
  status: CaseStatus;
  /** The failure message, first line only; null unless the case failed. */
  failure: string | null;
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};

function unescapeXml(text: string): string {
  return text.replace(/&(?:lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    if (entity.startsWith('&#x')) return String.fromCodePoint(parseInt(entity.slice(3, -1), 16));
    if (entity.startsWith('&#')) return String.fromCodePoint(Number(entity.slice(2, -1)));
    return ENTITIES[entity] ?? entity;
  });
}

/**
 * One lane's end-to-end cases in a vitest JUnit report. Unit tests, and the
 * other lane's suite (which skips itself), are left out.
 */
export function parseScenarioCases(xml: string, lane: Lane): ScenarioCase[] {
  const cases: ScenarioCase[] = [];
  const pattern =
    /<testcase classname="([^"]*)" name="([^"]*)" time="([^"]*)"\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const file = unescapeXml(match[1] ?? '');
    if (!file.startsWith(`src/${lane}/`) || !file.includes('.e2e.test.')) continue;
    const body = match[4] ?? '';
    const failed = /<(failure|error)\b/.exec(body);
    const failureMessage = /<(?:failure|error)\b[^>]*\bmessage="([^"]*)"/.exec(body)?.[1];
    cases.push({
      file,
      name: unescapeXml(match[2] ?? ''),
      seconds: Number(match[3] ?? 0),
      status: failed ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass',
      failure: failed
        ? unescapeXml(failureMessage ?? 'failed')
            .split('\n')[0]!
            .slice(0, 200)
        : null,
    });
  }
  return cases;
}

export function summaryLine(title: string, cases: readonly ScenarioCase[]): string {
  const count = (status: CaseStatus) => cases.filter((each) => each.status === status).length;
  return `${title}: ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`;
}

const MARK: Record<CaseStatus, string> = { pass: '✅', fail: '❌', skip: '⏭️' };

export function summaryMarkdown(title: string, cases: readonly ScenarioCase[]): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = cases.map(
    (each) =>
      `| ${MARK[each.status]} | ${cell(each.name)} | ${each.seconds.toFixed(1)}s | ${cell(each.failure ?? '')} |`
  );
  return [
    `### ${summaryLine(title, cases)}`,
    '',
    ...(cases.length === 0
      ? ['The report holds no end-to-end scenarios.']
      : ['| | scenario | time | failure |', '|---|---|---|---|', ...rows]),
    '',
  ].join('\n');
}

export function main(argv: readonly string[]): void {
  const [reportPath, lane, title] = argv;
  if (!reportPath || lane === undefined || !isLane(lane) || !title) {
    throw new Error(`Usage: ci-summary.ts <junit.xml> <${LANES.join('|')}> <title>`);
  }
  let xml: string;
  try {
    xml = readFileSync(reportPath, 'utf8');
  } catch (error) {
    throw new Error(
      `No JUnit report at ${reportPath} (${message(error)}): the lane stopped before its suite ran.`
    );
  }
  const cases = parseScenarioCases(xml, lane);
  process.stdout.write(summaryMarkdown(title, cases));
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `line=${summaryLine(title, cases)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(message(error));
    process.exitCode = 1;
  }
}
