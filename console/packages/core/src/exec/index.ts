export { createBoundExec, type CreateBoundExecOptions } from './bound-exec';
export { type ExecContextOptions, type IExecutionContext } from './execution-context';
export { isTransportFailure, TransportError } from './transport-error';
export {
  getWindowsEnvKey,
  getWindowsEnvValue,
  getWindowsPathDirs,
  getWindowsPathExts,
  getWindowsShellExecutable,
  escapeCmdExeArgument,
  escapeCmdExeCommand,
  resolveExecFileSpawn,
  resolveWindowsCommandPath,
  type ExecFileSpawn,
  type FileExists,
} from '@switch-console/shared/windows-spawn';
export {
  ExecError,
  type BoundExec,
  type ExecBufferResult,
  type ExecOptions,
  type ExecResult,
} from './types';
