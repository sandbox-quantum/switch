/**
 * How long, and how built-up, what the agent posted was.
 *
 * Counts are of what reached the room: post bodies, not the model's final
 * text. Structure is counted as well as length because a wall of headings and
 * bullets reads as long on a phone even at a modest word count.
 */
import type { Post } from './fake-switch';
import type { Scenario } from './scenario';

export type Metrics = {
  posts: number;
  words: number;
  /** Words in the longest post: the one a reader actually has to get through. */
  longestPost: number;
  headings: number;
  bullets: number;
  /** Whether a short post came before the answer, as the skill asks before going quiet. */
  headsUp: boolean;
  /** Whether the last post ends by offering more ("Want me to…?"), which the skill rules out. */
  closingOffer: boolean;
};

const OFFER = /(want me to|happy to|shall i|should i|let me know|say the word)[^\n]*$/i;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function measure(posts: Post[]): Metrics {
  const lines = posts.flatMap((p) => p.body.split('\n'));
  return {
    posts: posts.length,
    words: posts.reduce((sum, p) => sum + words(p.body), 0),
    longestPost: Math.max(0, ...posts.map((p) => words(p.body))),
    // A markdown heading, or a line that is only a bold label.
    headings: lines.filter((l) => /^#{1,6}\s/.test(l) || /^\*\*[^*]+\*\*:?\s*$/.test(l.trim()))
      .length,
    bullets: lines.filter((l) => /^\s*([-*•]|\d+\.)\s/.test(l)).length,
    headsUp: posts.length > 1 && words(posts[0]!.body) < 40,
    closingOffer: posts.length > 0 && OFFER.test(posts[posts.length - 1]!.body.trim()),
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

type Record = { run: number; outcome: string; metrics: Metrics; posts: Post[] };

export function summarise(scenario: Scenario, label: string, records: Record[]): string {
  const rows = records.map(
    (r) =>
      `| ${r.run} | ${r.outcome} | ${r.metrics.posts} | ${r.metrics.words} | ${r.metrics.longestPost} | ${r.metrics.headings} | ${r.metrics.bullets} | ${r.metrics.headsUp ? 'yes' : 'no'} | ${r.metrics.closingOffer ? 'yes' : 'no'} |`
  );
  const col = (key: 'posts' | 'words' | 'longestPost' | 'headings' | 'bullets') =>
    median(records.map((r) => r.metrics[key]));
  const count = (key: 'headsUp' | 'closingOffer') =>
    `${records.filter((r) => r.metrics[key]).length}/${records.length}`;
  const posts = records.flatMap((r) =>
    r.posts.map((p, i) => `### Run ${r.run}, post ${i + 1} (${words(p.body)} words)\n\n${p.body}\n`)
  );
  return [
    `# ${scenario.name} — ${label}`,
    '',
    scenario.about,
    '',
    '| run | outcome | posts | words | longest post | headings | bullets | heads-up | closing offer |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    `| **median** | | ${col('posts')} | ${col('words')} | ${col('longestPost')} | ${col('headings')} | ${col('bullets')} | ${count('headsUp')} | ${count('closingOffer')} |`,
    '',
    '## What was posted',
    '',
    ...posts,
  ].join('\n');
}
