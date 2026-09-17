import type { ParamSpec } from '@main/core/room-templates/controller';
import type { ParamType } from '@shared/core/switch-servers/room-template-params';

export type Values = Record<string, string | number | boolean>;

/** Interpolate `{param}` and `{$builtin}` patterns with the values so far;
 * a placeholder with no value yet stays as written. */
export function interpolate(template: string, values: Values): string {
  return template.replace(/\{(\$?\w+)\}/g, (match, key: string) => {
    const val = values[key];
    return val !== undefined && val !== '' ? String(val) : match;
  });
}

export function hasPlaceholder(text: string): boolean {
  return /\{\$?\w+\}/.test(text);
}

/** The type as the page names it beside the input, in words rather than the schema's. */
export function typeLabel(type: ParamType): string {
  switch (type) {
    case 'string':
      return 'text';
    case 'boolean':
      return 'yes / no';
    case 'enum':
      return 'one of';
    default:
      return type;
  }
}

/** A param is required when the template gives it no default. A bridge is
 * the exception: left empty, the room lands on the server's default app. */
export function isRequired(param: ParamSpec): boolean {
  return param.default === null && param.type !== 'bridge';
}

/** The values a form starts with: each default, or empty. */
export function defaultsFor(params: ParamSpec[]): Values {
  const defaults: Values = {};
  for (const param of params) {
    if (param.default !== null) defaults[param.name] = param.default;
    else if (param.type === 'boolean') defaults[param.name] = false;
    else defaults[param.name] = '';
  }
  return defaults;
}

export function isEmpty(value: string | number | boolean | undefined): boolean {
  return value === undefined || value === '';
}

/** Params left empty that have no default. The server document is sent without them. */
export function unsetParams(params: ParamSpec[], values: Values): string[] {
  return params
    .filter((p) => p.type === 'bridge' && p.default === null && isEmpty(values[p.name]))
    .map((p) => p.name);
}

/** The required params still without a value. */
export function missingParams(params: ParamSpec[], values: Values): ParamSpec[] {
  return params.filter((p) => isRequired(p) && isEmpty(values[p.name]));
}

/** The inputs the server gets: every filled param it knows the type of, numbers as numbers. */
export function serverInputs(params: ParamSpec[], values: Values): Values {
  const inputs: Values = {};
  for (const param of params) {
    if (param.type === 'provider') continue;
    if (param.type === 'bridge' && isEmpty(values[param.name]) && param.default === null) continue;
    const val = values[param.name];
    if (isEmpty(val)) continue;
    inputs[param.name] = param.type === 'number' ? Number(val) : (val as string | boolean);
  }
  return inputs;
}
