/**
 * The template YAML editor runs the Monaco bundled with the app. Left to its
 * default, `@monaco-editor/react` injects a script from a CDN, which the
 * window's Content-Security-Policy refuses, so the editor never loads.
 */
import Editor, { loader } from '@monaco-editor/react';
import * as bundled from 'monaco-editor/editor/editor.api';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import '@renderer/lib/monaco';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

it('hands the loader the bundled Monaco, so no script is fetched', async () => {
  const scriptsBefore = document.scripts.length;
  let mountedAs: (language: string) => void = () => {};
  const mounted = new Promise<string>((resolve) => (mountedAs = resolve));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Editor
        height={200}
        language="yaml"
        value={'name: demo\n'}
        onMount={(editor) => mountedAs(editor.getModel()?.getLanguageId() ?? '')}
      />
    )
  );

  expect(await mounted).toBe('yaml');
  expect(loader.__getMonacoInstance()).toBe(bundled);
  expect(document.scripts.length).toBe(scriptsBefore);
  expect(container.querySelector('.monaco-editor')).not.toBeNull();
});

it('starts the editor worker from the app’s own bundle', async () => {
  const worker = await self.MonacoEnvironment?.getWorker?.('workerMain.js', 'editorWorkerService');
  expect(worker).toBeInstanceOf(Worker);
  // A diff is computed in the editor worker, so one arriving proves it loaded and answered.
  const changes = await new Promise<number>((resolve, reject) => {
    const original = bundled.editor.createModel('a\nb\n', 'yaml');
    const modified = bundled.editor.createModel('a\nc\n', 'yaml');
    const diff = bundled.editor.createDiffEditor(document.createElement('div'));
    diff.setModel({ original, modified });
    const timer = setTimeout(() => reject(new Error('the editor worker never answered')), 10_000);
    diff.onDidUpdateDiff(() => {
      clearTimeout(timer);
      resolve(diff.getLineChanges()?.length ?? -1);
      diff.dispose();
      original.dispose();
      modified.dispose();
    });
  });
  worker?.terminate();
  expect(changes).toBe(1);
});
