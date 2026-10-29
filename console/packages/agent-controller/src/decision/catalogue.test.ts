import { describe, expect, it } from 'vitest';
import type { DecisionHardware } from '../schemas';
import {
  buildFor,
  CATALOGUE,
  catalogueModel,
  LLAMA_CPP_VERSION,
  type Machine,
  offeredModels,
  QWEN35_4B,
  RUNTIME_BUILDS,
} from './catalogue';

const GIB = 1024 ** 3;

function machine(
  platform: NodeJS.Platform,
  arch: string,
  hardware: DecisionHardware,
  nvidiaDriver: string | null = null
): Machine {
  return { platform, arch, hardware, nvidiaDriver };
}

const mac = machine('darwin', 'arm64', { accelerator: 'apple_silicon', memory_bytes: 16 * GIB });
const linuxCpu = machine('linux', 'x64', { accelerator: 'cpu', memory_bytes: 16 * GIB });
const linuxNvidia = (driver: string, vramGib = 24) =>
  machine(
    'linux',
    'x64',
    {
      accelerator: 'nvidia',
      memory_bytes: 32 * GIB,
      gpu_name: 'NVIDIA L4',
      vram_bytes: vramGib * GIB,
    },
    driver
  );

describe('the pinned catalogue', () => {
  it('pins Qwen3.5-4B Q4_K_M from unsloth’s repository at a fixed commit, by its SHA-256', () => {
    expect(QWEN35_4B).toMatchObject({
      id: 'qwen3.5-4b-q4_k_m',
      label: 'Qwen3.5-4B',
      kind: 'llamacpp',
    });
    expect(QWEN35_4B.file.url).toMatch(
      /^https:\/\/huggingface\.co\/unsloth\/Qwen3\.5-4B-GGUF\/resolve\/[0-9a-f]{40}\/Qwen3\.5-4B-Q4_K_M\.gguf$/
    );
    expect(QWEN35_4B.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(QWEN35_4B.file.bytes).toBe(2_740_937_888);
    expect(QWEN35_4B).toMatchObject({ contextSize: 16384, parallel: 4 });
    expect(catalogueModel(CATALOGUE, 'qwen3.5-4b-q4_k_m')).toBe(QWEN35_4B);
    expect(catalogueModel(CATALOGUE, 'something-else')).toBeNull();
  });

  it('pins every llama.cpp archive to one release, over https, by its SHA-256', () => {
    for (const build of Object.values(RUNTIME_BUILDS)) {
      expect(build.version).toBe(LLAMA_CPP_VERSION);
      expect(build.binary).toBe(`llama-${LLAMA_CPP_VERSION}/llama-server`);
      for (const archive of build.archives) {
        expect(archive.url).toMatch(
          new RegExp(
            `^https://github\\.com/ggml-org/llama\\.cpp/releases/download/${LLAMA_CPP_VERSION}/[^/]+\\.tar\\.gz$`
          )
        );
        expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(archive.bytes).toBeGreaterThan(0);
      }
    }
    expect(RUNTIME_BUILDS['macos-arm64-metal'].gpuLayers).toBe(99);
    expect(RUNTIME_BUILDS['linux-x64-cpu'].gpuLayers).toBe(0);
  });
});

describe('what a machine is offered', () => {
  it('offers Qwen3.5-4B on Apple Silicon, fast, on Metal, with what it downloads', () => {
    expect(offeredModels(CATALOGUE, mac)).toEqual([
      {
        model: 'qwen3.5-4b-q4_k_m',
        label: 'Qwen3.5-4B',
        kind: 'llamacpp',
        runtime: 'llamacpp-metal',
        download_bytes:
          QWEN35_4B.file.bytes + RUNTIME_BUILDS['macos-arm64-metal'].archives[0].bytes,
        speed: 'fast',
      },
    ]);
  });

  it('offers it on Linux x64 with an NVIDIA GPU and a driver for CUDA 12.8, fast', () => {
    expect(offeredModels(CATALOGUE, linuxNvidia('575.57.08'))).toMatchObject([
      { runtime: 'llamacpp-cuda', speed: 'fast' },
    ]);
    expect(buildFor(CATALOGUE, linuxNvidia('570.26'), QWEN35_4B)).toBe(
      RUNTIME_BUILDS['linux-x64-cuda']
    );
  });

  it('falls back to the CPU build, slow, on an older NVIDIA driver or a small GPU', () => {
    expect(offeredModels(CATALOGUE, linuxNvidia('535.104.05'))).toMatchObject([
      { runtime: 'llamacpp-cpu', speed: 'slow' },
    ]);
    expect(offeredModels(CATALOGUE, linuxNvidia('575.1', 2))).toMatchObject([
      { runtime: 'llamacpp-cpu', speed: 'slow' },
    ]);
  });

  it('offers it on the CPU of other Linux x64 machines, slow', () => {
    expect(offeredModels(CATALOGUE, linuxCpu)).toMatchObject([
      { model: 'qwen3.5-4b-q4_k_m', runtime: 'llamacpp-cpu', speed: 'slow' },
    ]);
  });

  it('offers nothing where no build is pinned or memory is short', () => {
    const none = [
      machine('darwin', 'x64', { accelerator: 'cpu', memory_bytes: 16 * GIB }),
      machine('darwin', 'arm64', { accelerator: 'apple_silicon', memory_bytes: 4 * GIB }),
      machine('linux', 'arm64', { accelerator: 'cpu', memory_bytes: 16 * GIB }),
      machine('linux', 'x64', { accelerator: 'cpu', memory_bytes: 4 * GIB }),
      machine('win32', 'x64', { accelerator: 'cpu', memory_bytes: 16 * GIB }),
    ];
    for (const entry of none) expect(offeredModels(CATALOGUE, entry)).toEqual([]);
  });
});
