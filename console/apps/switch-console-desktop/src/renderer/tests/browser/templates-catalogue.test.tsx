import '@renderer/index.css';
/**
 * The Templates page and a template's page as Console draws them, in real CSS
 * and in both themes: each card carries its corner tint. Saves screenshots
 * under the app's gitignored `build/acceptance/`.
 */
import { ServerPage } from '@switch-console/chat-ui/components/server-page';
import { TemplateCard } from '@switch-console/chat-ui/components/template-card';
import {
  TemplateFilters,
  TemplateResults,
  TemplateScopeTabs,
} from '@switch-console/chat-ui/components/template-catalogue';
import {
  TemplateCreates,
  TemplateDetailFrame,
  TemplateDetailHeader,
} from '@switch-console/chat-ui/components/template-detail';
import { Button } from '@switch-console/chat-ui/primitives/button';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { LIST_PAGE_WIDTH } from '@renderer/lib/components/list-toolbar';
import { SearchInput } from '@renderer/lib/ui/search-input';

const SHOTS = '../../../../build/acceptance/templates';

const TEMPLATES = [
  ['switch-buddy', 'agent', 'Your own assistant in Switch. It creates agents and rooms for you.'],
  [
    'All-Hands Prep Room',
    'room',
    'Preparing company all-hands: talking points, slides and speakers.',
  ],
  [
    'Architecture Decision Room',
    'room',
    'Evaluating and documenting significant technical decisions.',
  ],
  [
    'Brand & Messaging Room',
    'room',
    'Keeping the brand consistent and evolving the messaging framework.',
  ],
  [
    'Budget Planning Room',
    'room',
    'The budget cycle: department submissions, reviews and approval.',
  ],
  ['Bug Triage Room', 'room', 'Daily bug triage: reviewing incoming bugs, setting severity.'],
  ['Team Space', 'group', 'A team’s rooms, made by someone on the workspace.'],
].map(([name, kind, description], i) => ({
  id: `t${i}`,
  name,
  kind,
  description,
  official: kind !== 'group',
  creator: 'Ada',
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  document.documentElement.classList.remove('emdark');
});

async function mount(node: React.ReactNode) {
  container = document.createElement('div');
  container.className = 'flex flex-col bg-background text-foreground';
  container.style.width = '1280px';
  container.style.height = '900px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

function Catalogue() {
  return (
    <ServerPage
      width={LIST_PAGE_WIDTH}
      title="Templates"
      term="template"
      description="Templates create a complete room setup - agents, roles, documents - from a single configuration."
    >
      <div className="space-y-6">
        <TemplateScopeTabs
          value="all"
          onChange={() => {}}
          counts={{ all: 7, official: 6, workspace: 1, yours: 0 }}
          showYours
        />
        <TemplateFilters
          search={
            <SearchInput
              placeholder="Search templates"
              containerClassName="w-full"
              className="h-9"
            />
          }
          kinds={[]}
          onToggleKind={() => {}}
        />
        <TemplateResults
          loading={false}
          error={null}
          onRetry={() => {}}
          recent={[]}
          shown={TEMPLATES}
          filtering={false}
          scope="all"
          card={(t) => <TemplateCard key={t.id} template={t} onOpen={() => {}} actions={null} />}
        />
      </div>
    </ServerPage>
  );
}

function Detail() {
  return (
    <TemplateDetailFrame>
      <TemplateDetailHeader
        name="switch-buddy"
        description="Your own assistant in Switch. It creates agents and rooms for you, answers anything about Switch and helps with any task."
        ownerLine="Comes with Switch"
        accessLine="Shared with the workspace"
        version={11}
        kind="agent"
        official
        onBack={() => {}}
        actions={<Button size="sm">Use template</Button>}
      />
      <TemplateCreates
        creates={[
          { kind: 'agent', name: 'switch-buddy', description: 'Your own assistant in Switch.' },
        ]}
        summary={null}
      >
        {null}
      </TemplateCreates>
    </TemplateDetailFrame>
  );
}

it.each(['light', 'dark'])('draws every template card with its corner tint (%s)', async (theme) => {
  if (theme === 'dark') document.documentElement.classList.add('emdark');
  await page.viewport(1280, 900);
  await mount(<Catalogue />);

  const cards = [...container!.querySelectorAll('button[aria-label^="Open "]')].map(
    (b) => b.parentElement!
  );
  expect(cards).toHaveLength(TEMPLATES.length);
  for (const card of cards) {
    expect(getComputedStyle(card).backgroundImage).toContain('radial-gradient');
  }
  await page.screenshot({ path: `${SHOTS}/templates-console-${theme}.png`, element: container! });

  await act(async () => root!.render(<Detail />));
  await page.screenshot({
    path: `${SHOTS}/template-detail-console-${theme}.png`,
    element: container!,
  });
});
