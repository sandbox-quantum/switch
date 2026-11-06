import { describe, expect, it } from 'vitest';
import { detectHardware, type RunCommand } from './hardware';

const GIB = 1024 ** 3;

/** Answers each command line from `answers`; anything else is a command that is not there. */
function commands(answers: Record<string, string>): RunCommand & { asked: string[] } {
  const asked: string[] = [];
  const run = async (command: string, args: string[]) => {
    const line = [command, ...args].join(' ');
    asked.push(line);
    const answer = answers[line];
    if (answer === undefined) throw new Error(`${command}: command not found`);
    return answer;
  };
  return Object.assign(run, { asked });
}

const NVIDIA_SMI =
  'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits';

describe('detectHardware', () => {
  it('reads an Apple Silicon Mac from sysctl, its chip as the GPU, and its memory as shared', async () => {
    const run = commands({
      'sysctl -n hw.optional.arm64': '1\n',
      'sysctl -n machdep.cpu.brand_string': 'Apple M4 Pro\n',
    });
    expect(await detectHardware({ platform: 'darwin', totalMemory: 48 * GIB, run })).toEqual({
      hardware: { accelerator: 'apple_silicon', memory_bytes: 48 * GIB, gpu_name: 'Apple M4 Pro' },
      nvidiaDriver: null,
    });
    expect(run.asked).not.toContain(NVIDIA_SMI);
  });

  it('reads an Intel Mac, where hw.optional.arm64 is 0 or absent, as the CPU', async () => {
    for (const answers of [{ 'sysctl -n hw.optional.arm64': '0\n' }, {}] as Record<
      string,
      string
    >[]) {
      expect(
        (
          await detectHardware({
            platform: 'darwin',
            totalMemory: 16 * GIB,
            run: commands(answers),
          })
        ).hardware
      ).toEqual({ accelerator: 'cpu', memory_bytes: 16 * GIB });
    }
  });

  it('reads the first NVIDIA GPU nvidia-smi lists on Linux, with its memory and driver', async () => {
    const run = commands({
      [NVIDIA_SMI]: 'NVIDIA L4, 23034, 575.57.08\nNVIDIA L4, 23034, 575.57.08\n',
    });
    expect(await detectHardware({ platform: 'linux', totalMemory: 64 * GIB, run })).toEqual({
      hardware: {
        accelerator: 'nvidia',
        memory_bytes: 64 * GIB,
        gpu_name: 'NVIDIA L4',
        vram_bytes: 23034 * 1024 ** 2,
      },
      nvidiaDriver: '575.57.08',
    });
  });

  it('reads Linux with no nvidia-smi, or one that lists nothing, as the CPU', async () => {
    for (const answers of [{}, { [NVIDIA_SMI]: '\n' }] as Record<string, string>[]) {
      expect(
        await detectHardware({ platform: 'linux', totalMemory: 8 * GIB, run: commands(answers) })
      ).toEqual({ hardware: { accelerator: 'cpu', memory_bytes: 8 * GIB }, nvidiaDriver: null });
    }
  });

  it('leaves out a GPU memory nvidia-smi cannot say', async () => {
    const run = commands({ [NVIDIA_SMI]: 'NVIDIA GeForce RTX 4090, [N/A], 580.1\n' });
    const { hardware } = await detectHardware({ platform: 'linux', totalMemory: GIB, run });
    expect(hardware).toEqual({
      accelerator: 'nvidia',
      memory_bytes: GIB,
      gpu_name: 'NVIDIA GeForce RTX 4090',
    });
  });
});
