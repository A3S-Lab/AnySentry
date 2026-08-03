export interface A3sCodeModelConfig {
  id: string;
  name: string;
  url: string;
  model: string;
  key: string;
  contextLimit?: number;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function hclString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build one A3S Code model configuration for all model-backed judgment stages.
 *
 * The provider block deliberately uses Code's OpenAI-compatible adapter instead of constructing
 * an HTTP endpoint in AnySentry. A3S Code owns base-URL normalization, provider request routing,
 * structured-output negotiation, and response adaptation.
 */
export function buildA3sCodeModelAcl(config: A3sCodeModelConfig): string {
  const model = config.model.trim();
  const url = config.url.trim();
  if (!model) throw new Error('A3S Code model id is required');
  if (!url) throw new Error('A3S Code model URL is required');
  return [
    `id = ${hclString(config.id)}`,
    `name = ${hclString(config.name)}`,
    `default_model = ${hclString(`openai/${model}`)}`,
    'providers "openai" {',
    '  id = "openai"',
    '  name = "openai"',
    `  models ${hclString(model)} {`,
    `    id = ${hclString(model)}`,
    `    name = ${hclString(model)}`,
    `    apiKey = ${hclString(config.key.trim())}`,
    `    baseUrl = ${hclString(url)}`,
    '    limit = {',
    `      context = ${positiveInt(config.contextLimit, 32_768)}`,
    '    }',
    '  }',
    '}',
  ].join('\n');
}

export function fastReviewModelConfig(env: NodeJS.ProcessEnv = process.env): Pick<A3sCodeModelConfig, 'url' | 'model' | 'key'> {
  return {
    url: env.A3S_SENTRY_LLM_URL || 'http://localhost:18051/v1',
    model: env.A3S_SENTRY_LLM_MODEL || 'glm-5.2',
    key: env.A3S_SENTRY_LLM_KEY || '',
  };
}

export function deepInvestigationModelConfig(env: NodeJS.ProcessEnv = process.env): Pick<A3sCodeModelConfig, 'url' | 'model' | 'key'> {
  return {
    url: env.A3S_SENTRY_L3_URL || 'http://localhost:18051/v1',
    model: env.A3S_SENTRY_L3_MODEL || 'glm-5.2',
    key: env.A3S_SENTRY_L3_KEY || '',
  };
}
