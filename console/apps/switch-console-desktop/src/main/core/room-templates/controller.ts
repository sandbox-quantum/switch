import { writeFile } from 'node:fs/promises';
import { clipboard, dialog } from 'electron';
import { load } from 'js-yaml';
import { getMainWindow } from '@main/app/window';
import { createRPCController } from '@shared/lib/ipc/rpc';

export type ParamSpec = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  description: string | null;
  default: string | number | boolean | null;
  enum: string[] | null;
  isAgentName: boolean;
};

export type ParsedTemplate = {
  params: ParamSpec[];
  roomName: string | null;
  warnings: string[];
};

/** Convention: trigger the agent picker when the param is named exactly "agent" or ends in "_agent". */
function isAgentParam(name: string): boolean {
  return name === 'agent' || name.endsWith('_agent');
}

function extractParams(raw: unknown): ParamSpec[] {
  if (raw === null || raw === undefined || typeof raw !== 'object') return [];
  const params = raw as Record<string, unknown>;
  return Object.entries(params).map(([name, spec]) => {
    if (spec === null || typeof spec !== 'object') {
      return {
        name,
        type: 'string' as const,
        description: null,
        default: null,
        enum: null,
        isAgentName: isAgentParam(name),
      };
    }
    const s = spec as Record<string, unknown>;
    const type = typeof s.type === 'string' ? s.type : 'string';
    const validType = (['string', 'number', 'boolean', 'enum'] as const).includes(
      type as 'string' | 'number' | 'boolean' | 'enum'
    )
      ? (type as ParamSpec['type'])
      : ('string' as const);
    return {
      name,
      type: validType,
      description: typeof s.description === 'string' ? s.description : null,
      default: s.default !== undefined ? (s.default as ParamSpec['default']) : null,
      enum: Array.isArray(s.enum) ? (s.enum as string[]) : null,
      isAgentName: validType === 'string' && isAgentParam(name),
    };
  });
}

export const roomTemplatesController = createRPCController({
  /** Save YAML text to a file via the native save dialog. Returns the path, or
   * null if the user cancelled. */
  saveToFile: async (params: { yamlText: string; defaultName: string }): Promise<string | null> => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, {
      title: 'Save room template',
      defaultPath: params.defaultName,
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, params.yamlText, 'utf8');
    return result.filePath;
  },

  /** Copy YAML text to the system clipboard. */
  copyToClipboard: (params: { text: string }): void => {
    clipboard.writeText(params.text);
  },

  parse: (params: { yamlText: string }): ParsedTemplate => {
    const warnings: string[] = [];
    let doc: Record<string, unknown>;
    try {
      const parsed = load(params.yamlText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Template must be a YAML mapping');
      }
      doc = parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
    }

    const room = doc.room as Record<string, unknown> | undefined;
    const roomName = room && typeof room.name === 'string' ? room.name : null;
    const paramSpecs = extractParams(doc.params);

    if (!room) {
      warnings.push('Template has no "room:" block — the server may reject it.');
    }

    return { params: paramSpecs, roomName, warnings };
  },
});
