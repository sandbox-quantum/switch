import { execFile } from 'node:child_process';
import type { DecisionHardware } from '../schemas';

/** Runs a command and resolves with what it printed; rejects when it is missing, fails or hangs. */
export type RunCommand = (command: string, args: string[]) => Promise<string>;

const DETECT_TIMEOUT_MS = 5_000;

export const runDetectCommand: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: DETECT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });

export type DetectedHardware = {
  hardware: DecisionHardware;
  /** The NVIDIA driver's version, when nvidia-smi answered. */
  nvidiaDriver: string | null;
};

const MIB = 1024 ** 2;

/**
 * What this machine can run a decision model on: Apple Silicon (a Mac whose
 * `sysctl hw.optional.arm64` is 1, which an Intel Mac and Rosetta both
 * answer otherwise), the first NVIDIA GPU `nvidia-smi` lists, or else the CPU.
 * `memory_bytes` is the machine's memory, which Apple Silicon shares with its
 * GPU. A command that is missing or fails reads as that accelerator absent.
 */
export async function detectHardware(input: {
  platform: NodeJS.Platform;
  totalMemory: number;
  run: RunCommand;
}): Promise<DetectedHardware> {
  const memory_bytes = input.totalMemory;
  if (input.platform === 'darwin') {
    const arm64 = await input.run('sysctl', ['-n', 'hw.optional.arm64']).catch(() => '');
    if (arm64.trim() === '1') {
      const brand = (
        await input.run('sysctl', ['-n', 'machdep.cpu.brand_string']).catch(() => '')
      ).trim();
      return {
        hardware: {
          accelerator: 'apple_silicon',
          memory_bytes,
          ...(brand ? { gpu_name: brand.slice(0, 200) } : {}),
        },
        nvidiaDriver: null,
      };
    }
    return { hardware: { accelerator: 'cpu', memory_bytes }, nvidiaDriver: null };
  }
  if (input.platform === 'linux' || input.platform === 'win32') {
    const listed = await input
      .run('nvidia-smi', [
        '--query-gpu=name,memory.total,driver_version',
        '--format=csv,noheader,nounits',
      ])
      .catch(() => '');
    const first = listed
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      const [name, memory, driver] = first.split(',').map((field) => field.trim());
      const mib = Number.parseInt(memory ?? '', 10);
      if (name)
        return {
          hardware: {
            accelerator: 'nvidia',
            memory_bytes,
            gpu_name: name.slice(0, 200),
            ...(Number.isFinite(mib) && mib > 0 ? { vram_bytes: mib * MIB } : {}),
          },
          nvidiaDriver: driver || null,
        };
    }
  }
  return { hardware: { accelerator: 'cpu', memory_bytes }, nvidiaDriver: null };
}
