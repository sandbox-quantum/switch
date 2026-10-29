import type { DecisionHardware, DecisionOffer } from '../schemas';

/**
 * The decision models this controller can serve for auto-route, and the
 * llama.cpp builds it serves them with, each pinned by its SHA-256: nothing
 * is downloaded that does not match.
 *
 * The model is unsloth's Q4_K_M GGUF of Qwen3.5-4B, at a fixed commit of
 * its Hugging Face repository. The llama.cpp builds are one release's
 * binaries from github.com/ggml-org/llama.cpp, checked against the SHA-256
 * GitHub publishes for each asset.
 */

/** A file fetched over https and checked against its SHA-256 before it is used. */
export type Artifact = { url: string; sha256: string; bytes: number };

export type Runtime = DecisionOffer['runtime'];

/** One llama.cpp build for a platform: its archives, extracted into one directory. */
export type RuntimeBuild = {
  runtime: Runtime;
  /** The llama.cpp release, which names the directory the archives unpack into. */
  version: string;
  archives: Artifact[];
  /** llama-server, relative to the directory the archives were extracted in. */
  binary: string;
  /** Directories, relative to the same, holding the shared libraries it loads. */
  libraryDirs: string[];
  /** Layers offloaded to the GPU: all of them, or none on the CPU build. */
  gpuLayers: number;
};

export type CatalogueModel = {
  id: string;
  label: string;
  kind: 'llamacpp';
  file: Artifact;
  /** The context llama-server is started with, shared by its slots. */
  contextSize: number;
  /** llama-server's slots: as many decisions as it answers at once. */
  parallel: number;
  /** The least memory (unified, or the GPU's own) the machine needs to be offered it. */
  minMemoryBytes: number;
};

export const LLAMA_CPP_VERSION = 'b11981';

const RELEASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}`;

const GIB = 1024 ** 3;

export const QWEN35_4B: CatalogueModel = {
  id: 'qwen3.5-4b-q4_k_m',
  label: 'Qwen3.5-4B',
  kind: 'llamacpp',
  file: {
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf',
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    bytes: 2_740_937_888,
  },
  contextSize: 16384,
  parallel: 4,
  minMemoryBytes: 8 * GIB,
};

/** The builds, by the platform they run on. */
export type RuntimeBuilds = Record<
  'macos-arm64-metal' | 'linux-x64-cpu' | 'linux-x64-cuda',
  RuntimeBuild
>;

/** What can be served, and with which build. */
export type Catalogue = { models: readonly CatalogueModel[]; builds: RuntimeBuilds };

export const RUNTIME_BUILDS = {
  'macos-arm64-metal': {
    runtime: 'llamacpp-metal',
    version: LLAMA_CPP_VERSION,
    archives: [
      {
        url: `${RELEASE}/llama-${LLAMA_CPP_VERSION}-bin-macos-arm64.tar.gz`,
        sha256: 'c5827eba94fe4eb9068a82eab5c25a943dbd2022efe5144d1af817e8b396b45a',
        bytes: 16_463_687,
      },
    ],
    binary: `llama-${LLAMA_CPP_VERSION}/llama-server`,
    libraryDirs: [`llama-${LLAMA_CPP_VERSION}`],
    gpuLayers: 99,
  },
  'linux-x64-cpu': {
    runtime: 'llamacpp-cpu',
    version: LLAMA_CPP_VERSION,
    archives: [
      {
        url: `${RELEASE}/llama-${LLAMA_CPP_VERSION}-bin-ubuntu-x64.tar.gz`,
        sha256: '78986f25ddf08ba9b2d81b53ab6a6d68ac9548ad8022c19df75920a55f6d84ac',
        bytes: 22_691_734,
      },
    ],
    binary: `llama-${LLAMA_CPP_VERSION}/llama-server`,
    libraryDirs: [`llama-${LLAMA_CPP_VERSION}`],
    gpuLayers: 0,
  },
  'linux-x64-cuda': {
    runtime: 'llamacpp-cuda',
    version: LLAMA_CPP_VERSION,
    archives: [
      {
        url: `${RELEASE}/llama-${LLAMA_CPP_VERSION}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
        sha256: '5346ceedee45bda5bbd93cfd530ce6a8e1a2fd7a76369c9b2f508c5ce6cd4e4b',
        bytes: 182_533_348,
      },
      {
        // The CUDA runtime and cuBLAS it links, for a machine with the driver only.
        url: `${RELEASE}/cudart-llama-${LLAMA_CPP_VERSION}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
        sha256: '01dfe8b269a37cfda5aab7b5fe3d776c5521bbf277ec021738b991e17848a826',
        bytes: 594_371_567,
      },
    ],
    binary: `llama-${LLAMA_CPP_VERSION}/llama-server`,
    libraryDirs: [
      `llama-${LLAMA_CPP_VERSION}`,
      `cudart-llama-${LLAMA_CPP_VERSION}-bin-ubuntu-cuda-12.8-x64`,
    ],
    gpuLayers: 99,
  },
} as const satisfies RuntimeBuilds;

export const CATALOGUE: Catalogue = { models: [QWEN35_4B], builds: RUNTIME_BUILDS };

/** The oldest NVIDIA driver that runs CUDA 12.8 builds on Linux. */
export const MIN_CUDA_DRIVER = [570, 26] as const;

export type Machine = {
  platform: NodeJS.Platform;
  arch: string;
  hardware: DecisionHardware;
  /** The NVIDIA driver's version, when there is one. */
  nvidiaDriver: string | null;
};

function driverRunsCuda(version: string | null): boolean {
  if (version === null) return false;
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return (
    major > MIN_CUDA_DRIVER[0] || (major === MIN_CUDA_DRIVER[0] && minor >= MIN_CUDA_DRIVER[1])
  );
}

/**
 * The build this machine runs `model` with, or null when there is none for
 * it: Metal on Apple Silicon, CUDA on Linux x64 with an NVIDIA GPU that has
 * the memory and a driver new enough, the CPU build on any other Linux x64.
 */
export function buildFor(
  catalogue: Catalogue,
  machine: Machine,
  model: CatalogueModel
): RuntimeBuild | null {
  const { platform, arch, hardware } = machine;
  const builds = catalogue.builds;
  if (platform === 'darwin')
    return arch === 'arm64' &&
      hardware.accelerator === 'apple_silicon' &&
      hardware.memory_bytes >= model.minMemoryBytes
      ? builds['macos-arm64-metal']
      : null;
  if (platform !== 'linux' || arch !== 'x64') return null;
  if (
    hardware.accelerator === 'nvidia' &&
    (hardware.vram_bytes ?? 0) >= model.minMemoryBytes / 2 &&
    driverRunsCuda(machine.nvidiaDriver)
  )
    return builds['linux-x64-cuda'];
  return hardware.memory_bytes >= model.minMemoryBytes ? builds['linux-x64-cpu'] : null;
}

/** The models this machine can serve, each with the build it would use and what it downloads. */
export function offeredModels(catalogue: Catalogue, machine: Machine): DecisionOffer[] {
  return catalogue.models.flatMap((model) => {
    const build = buildFor(catalogue, machine, model);
    if (!build) return [];
    return [
      {
        model: model.id,
        label: model.label,
        kind: model.kind,
        runtime: build.runtime,
        download_bytes:
          model.file.bytes + build.archives.reduce((total, archive) => total + archive.bytes, 0),
        speed: build.runtime === 'llamacpp-cpu' ? 'slow' : 'fast',
      },
    ];
  });
}

export function catalogueModel(catalogue: Catalogue, id: string): CatalogueModel | null {
  return catalogue.models.find((model) => model.id === id) ?? null;
}
