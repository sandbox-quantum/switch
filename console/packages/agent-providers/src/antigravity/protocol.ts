import type { ModelChoice } from '@switch-console/shared/session-v1';

export interface ConfigChoice {
  value: string;
  name: string;
}
export interface ConfigOption {
  id: string;
  type: string;
  currentValue?: string;
  options?: Array<ConfigChoice | { options: ConfigChoice[] }>;
}
export function modelsFromConfig(options: ConfigOption[]): ModelChoice[] {
  const model = options.find((option) => option.id === 'model' && option.type === 'select');
  return (model?.options ?? [])
    .flatMap((option) => ('value' in option ? [option] : option.options))
    .map((option) => ({ id: option.value, label: option.name, options: {}, imageInput: true }));
}
