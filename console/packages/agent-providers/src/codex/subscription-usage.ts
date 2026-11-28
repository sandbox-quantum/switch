import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  clampUsagePercent,
  normalizeUsageTimestamp,
  type ProviderSubscriptionUsageResult,
  type ReadSubscriptionUsage,
  type SubscriptionUsageWindow,
} from '../subscription-usage';
import { JsonRpcError } from '../transport/stdio-json-rpc';
import { withCodexAppServer } from './app-server';
import { isUnknownCodexMethod } from './keyring-login';

const accountSchema = z.object({
  account: z
    .object({
      type: z.string(),
      accountId: z.string().nullish(),
      planType: z.string().nullish(),
    })
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
  workspaceRouting: z.object({ chatgptAccountId: z.string().nullish() }).nullish(),
});
const windowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().int().positive().nullish(),
  resetsAt: z.number().nullish(),
});
const rateLimitsResponseSchema = z.object({
  accountId: z.string().nullish(),
  rateLimits: z.unknown(),
});
const rateLimitsSchema = z.object({
  primary: windowSchema.nullish(),
  secondary: windowSchema.nullish(),
  planType: z.string().nullish(),
  individualLimit: z
    .object({ remainingPercent: z.number(), resetsAt: z.number().nullish() })
    .nullish(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.union([z.number(), z.string()]).nullish(),
    })
    .nullish(),
});
const planLabels: Readonly<Record<string, string>> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

function fingerprint(accountId: string | null | undefined): string | null {
  return accountId ? createHash('sha256').update(accountId).digest('hex').slice(0, 16) : null;
}

function toWindow(value: z.infer<typeof windowSchema>, id: string): SubscriptionUsageWindow {
  const minutes = value.windowDurationMins ?? null;
  const label =
    minutes === null
      ? 'Usage limit'
      : minutes === 1440
        ? '24h'
        : minutes % 1440 === 0
          ? `${minutes / 1440}d`
          : minutes % 60 === 0
            ? `${minutes / 60}h`
            : `${minutes}m`;
  return {
    id,
    label,
    usedPercent: clampUsagePercent(value.usedPercent),
    windowMinutes: minutes,
    resetsAt: normalizeUsageTimestamp(value.resetsAt),
  };
}

function failure(
  error: unknown,
  accountFingerprint: string | null
): ProviderSubscriptionUsageResult {
  const base = {
    providerId: 'codex',
    source: 'rpc',
    windows: [],
    updatedAt: null,
    accountFingerprint,
  } as const;
  if (isUnknownCodexMethod(error, 'account/rateLimits/read'))
    return {
      ...base,
      windows: [],
      status: 'unavailable',
      message: 'Update Codex to read subscription usage.',
    };
  if (error instanceof JsonRpcError) {
    // Codex may wrap an upstream HTTP status in its JSON-RPC error message.
    if (error.code === 401 || /\b401\b|\bunauthorized\b/i.test(error.message))
      return {
        ...base,
        windows: [],
        status: 'unauthenticated',
        message: 'Sign in to Codex to read subscription usage.',
      };
    if (error.code === 429 || /\b429\b|too many requests/i.test(error.message))
      return {
        ...base,
        windows: [],
        status: 'error',
        message: 'Codex is rate limiting usage requests.',
        retryAt: Date.now() + 5 * 60_000,
      };
  }
  return {
    ...base,
    windows: [],
    status: 'error',
    message: 'Could not read Codex subscription usage.',
  };
}

export const readCodexSubscriptionUsage: ReadSubscriptionUsage = async (input) => {
  let accountFingerprint: string | null = null;
  try {
    return await withCodexAppServer(input, [], Date.now() + 15_000, async (client) => {
      const { account, requiresOpenaiAuth, workspaceRouting } = accountSchema.parse(
        await client.request('account/read', { refreshToken: false })
      );
      const base = {
        providerId: 'codex',
        source: 'rpc',
        windows: [],
        updatedAt: Date.now(),
      } satisfies Partial<ProviderSubscriptionUsageResult>;
      if (!account && requiresOpenaiAuth)
        return {
          ...base,
          status: 'unauthenticated',
          message: 'Sign in to Codex to read subscription usage.',
        };
      if (account?.type !== 'chatgpt')
        return {
          ...base,
          status: 'unavailable',
          message: 'A ChatGPT subscription sign-in is required for Codex usage.',
        };
      // Workspace identity is sometimes missing from account/read. Email is
      // shared by the user's workspaces and cannot identify their quota.
      accountFingerprint = fingerprint(workspaceRouting?.chatgptAccountId ?? account.accountId);
      const usage = rateLimitsResponseSchema.parse(
        await client.request('account/rateLimits/read', {})
      );
      accountFingerprint = fingerprint(usage.accountId) ?? accountFingerprint;
      const rateLimits = rateLimitsSchema.parse(usage.rateLimits);
      const windows = [
        ...(rateLimits.primary ? [toWindow(rateLimits.primary, 'primary')] : []),
        ...(rateLimits.secondary ? [toWindow(rateLimits.secondary, 'secondary')] : []),
      ];
      if (windows.length === 0 && rateLimits.individualLimit) {
        const { remainingPercent, resetsAt } = rateLimits.individualLimit;
        windows.push({
          id: 'individual',
          label: 'Monthly spend limit',
          usedPercent: clampUsagePercent(100 - remainingPercent),
          windowMinutes: null,
          resetsAt: normalizeUsageTimestamp(resetsAt),
        });
      }
      const credits = rateLimits.credits;
      const rawBalance = credits?.balance;
      const balance =
        rawBalance == null || (typeof rawBalance === 'string' && rawBalance.trim() === '')
          ? NaN
          : Number(rawBalance);
      const plan = rateLimits.planType ?? account.planType ?? '';
      return {
        ...base,
        status: 'ok',
        windows,
        updatedAt: Date.now(),
        accountFingerprint,
        planLabel: Object.hasOwn(planLabels, plan) ? planLabels[plan] : null,
        extraUsage: credits
          ? {
              unit: 'credits',
              enabled: credits.hasCredits || credits.unlimited || Number.isFinite(balance),
              unlimited: credits.unlimited,
              balance: Number.isFinite(balance) ? balance : null,
            }
          : null,
      };
    });
  } catch (error) {
    input.signal.throwIfAborted();
    return failure(error, accountFingerprint);
  }
};
