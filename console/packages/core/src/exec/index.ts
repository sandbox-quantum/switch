export { createBoundExec, type CreateBoundExecOptions } from './bound-exec';
export { type ExecContextOptions, type IExecutionContext } from './execution-context';
export { isTransportFailure, TransportError } from './transport-error';
export {
  getWindowsEnvKey,
  getWindowsEnvValue,
  getWindowsPathDirs,
  getWindowsPathExts,
  getWindowsShellExecutable,
  quoteForCmdExe,
  resolveExecFileSpawn,
  resolveWindowsCommandPath,
  wrapCmdExeCommandLine,
  type ExecFileSpawn,
  type FileExists,
} from './windows-spawn';
export {
  ExecError,
  type BoundExec,
  type ExecBufferResult,
  type ExecOptions,
  type ExecResult,
} from './types';
