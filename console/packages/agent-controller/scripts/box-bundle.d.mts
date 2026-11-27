import type { Plugin } from 'esbuild';

/** The part of esbuild's metafile these checks read. */
export type BundleInputs = {
  inputs: Record<string, { imports?: { path: string; kind: string; external?: boolean }[] }>;
};

export function isBoxModule(path: string): boolean;
export function staticBoxImports(metafile: BundleInputs): string[];
export function boxModules(metafile: BundleInputs): string[];
export function assertDesktopBundle(metafile: BundleInputs, name: string): void;
export function assertBoxBundle(metafile: BundleInputs, name: string): void;
export const boxEvaluationGuard: Plugin;
