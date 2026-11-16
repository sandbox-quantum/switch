import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { errorMessage, type Logger } from './log';
import { providerStatusSchema } from './schemas';
import type { ProviderSeed } from './status';

/**
 * Provider checks written by `precheck` and read by `run --provider-seed`:
 * Switch Console checks the providers as onboarding opens, before this
 * computer is enrolled anywhere, and hands the result to the controller it
 * starts later, so the controller's first report already says what is signed
 * in.
 */
const providerSeedFileSchema = z.object({
  providers: z.array(z.object({ status: providerStatusSchema, path: z.string().nullable() })),
});

/** Writes `seed` whole, so a reader never finds it half written. */
export async function writeProviderSeed(file: string, seed: ProviderSeed): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ providers: seed }), { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * The checks in `file`; none when there is no file. One that cannot be read
 * is said in the log and left out: the controller checks for itself, as it
 * would have without it.
 */
export async function readProviderSeed(file: string, log: Logger): Promise<ProviderSeed> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn('Could not read the provider checks handed over; checking every provider here', {
      file,
      error: errorMessage(error),
    });
    return [];
  }
  try {
    return providerSeedFileSchema.parse(JSON.parse(text)).providers;
  } catch (error) {
    log.warn('The provider checks handed over are not readable; checking every provider here', {
      file,
      error: errorMessage(error),
    });
    return [];
  }
}
