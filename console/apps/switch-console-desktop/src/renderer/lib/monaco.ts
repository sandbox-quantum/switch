import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/yaml/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

/**
 * Monaco from the app's own bundle. Left alone, `@monaco-editor/react` fetches
 * it from a CDN, which the window's Content-Security-Policy refuses
 * (`script-src 'self'`), so the editor would sit on "Loading…"; and loosening
 * the policy would run a third party's script beside the preload bridge.
 * Importing this module before an `Editor` mounts hands the loader this copy.
 *
 * It is the editor with its features and YAML, the one language the app edits.
 * YAML is only tokenized, so the editor's own worker is the only one it needs,
 * bundled and served from the app's origin. The whole `monaco-editor` entry
 * would add every language and the TypeScript, CSS, HTML and JSON workers,
 * some 26 MB the app never loads. A language added here that has a worker of
 * its own needs that worker added to `getWorker` too.
 */
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
