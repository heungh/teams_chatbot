/**
 * Runtime configuration loader for the chatbot.
 *
 * Resolution order (per value):
 *   1. Process env var (for local dev / CI)
 *   2. SSM Parameter Store (default at runtime)
 *   3. Hard default for region/model only
 *
 * Account ID is derived via STS GetCallerIdentity if needed
 * (only when MODEL_ID is an inference profile pattern).
 *
 * Cached in-memory for the lifetime of the Node.js process.
 */

import {
  SSMClient,
  GetParametersCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const PARAM_PREFIX = process.env.PARAM_PREFIX ?? '/teams-bedrock-chatbot';
const DEFAULT_REGION = 'us-west-2';
const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';

const PARAM_KB_ID = `${PARAM_PREFIX}/kb-id`;
const PARAM_MODEL_ID = `${PARAM_PREFIX}/model-id`;

export interface ResolvedConfig {
  region: string;
  /** Empty string if not needed (foundation-model MODEL_ID). */
  accountId: string;
  kbId: string;
  modelId: string;
  /** Provenance per value — useful when debugging or surfacing in `/api/config`. */
  source: {
    region: 'env' | 'default';
    accountId: 'env' | 'sts' | 'unused';
    kbId: 'env' | 'ssm';
    modelId: 'env' | 'ssm' | 'default';
  };
}

let cached: ResolvedConfig | undefined;
let inflight: Promise<ResolvedConfig> | undefined;

export async function loadConfig(): Promise<ResolvedConfig> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = doLoad().finally(() => {
    inflight = undefined;
  });
  cached = await inflight;
  return cached;
}

/** Reset cache — call after a teardown/redeploy to pick up new values. */
export function resetConfigCache(): void {
  cached = undefined;
  inflight = undefined;
}

export function resolveModelArn(config: ResolvedConfig): string {
  const { modelId, region, accountId } = config;
  if (modelId.startsWith('arn:')) return modelId;
  if (/^(us|global|eu|apac)\./i.test(modelId)) {
    if (!accountId) {
      throw new Error(
        `Inference profile MODEL_ID "${modelId}" requires accountId, but none was resolved.`,
      );
    }
    return `arn:aws:bedrock:${region}:${accountId}:inference-profile/${modelId}`;
  }
  return `arn:aws:bedrock:${region}::foundation-model/${modelId}`;
}

async function doLoad(): Promise<ResolvedConfig> {
  const region = process.env.AWS_REGION ?? DEFAULT_REGION;
  const regionSource: ResolvedConfig['source']['region'] = process.env.AWS_REGION
    ? 'env'
    : 'default';

  let kbId = process.env.KB_ID?.trim() || undefined;
  let kbIdSource: ResolvedConfig['source']['kbId'] = 'env';
  let modelId = process.env.MODEL_ID?.trim() || undefined;
  let modelIdSource: ResolvedConfig['source']['modelId'] = 'env';

  if (!kbId || !modelId) {
    const ssmValues = await readSsmParams(region, [PARAM_KB_ID, PARAM_MODEL_ID]);
    if (!kbId) {
      kbId = ssmValues.get(PARAM_KB_ID);
      kbIdSource = 'ssm';
    }
    if (!modelId) {
      modelId = ssmValues.get(PARAM_MODEL_ID);
      modelIdSource = 'ssm';
    }
  }

  if (!kbId) {
    throw new Error(
      `KB_ID not found. Set env var KB_ID or SSM parameter ${PARAM_KB_ID}`,
    );
  }
  if (!modelId) {
    modelId = DEFAULT_MODEL_ID;
    modelIdSource = 'default';
  }

  let accountId = process.env.AWS_ACCOUNT_ID?.trim() || '';
  let accountIdSource: ResolvedConfig['source']['accountId'] = 'env';
  const isInferenceProfile =
    !modelId.startsWith('arn:') && /^(us|global|eu|apac)\./i.test(modelId);

  if (isInferenceProfile && !accountId) {
    accountId = await fetchAccountIdViaSts(region);
    accountIdSource = 'sts';
  } else if (!isInferenceProfile) {
    accountIdSource = 'unused';
  }

  return {
    region,
    accountId,
    kbId,
    modelId,
    source: {
      region: regionSource,
      accountId: accountIdSource,
      kbId: kbIdSource,
      modelId: modelIdSource,
    },
  };
}

async function readSsmParams(
  region: string,
  names: string[],
): Promise<Map<string, string>> {
  const client = new SSMClient({ region });
  try {
    const result = await client.send(new GetParametersCommand({ Names: names }));
    const map = new Map<string, string>();
    for (const p of result.Parameters ?? []) {
      if (p.Name && p.Value) map.set(p.Name, p.Value);
    }
    return map;
  } catch (err) {
    if (err instanceof ParameterNotFound) return new Map();
    // Other failures (auth, network) — surface but allow caller to fall back
    console.warn(
      `SSM GetParameters failed (${(err as Error).name}): ${(err as Error).message}`,
    );
    return new Map();
  }
}

async function fetchAccountIdViaSts(region: string): Promise<string> {
  const sts = new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) {
    throw new Error('STS GetCallerIdentity returned no Account');
  }
  return identity.Account;
}
