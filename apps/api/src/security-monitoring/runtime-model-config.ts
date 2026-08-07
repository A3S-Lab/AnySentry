import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { normalizeLlmBaseUrl } from './policy-config';

export type RuntimeModelProfile = 'fast_review' | 'deep_investigation';
export type RuntimeCredentialSource = 'runtime' | 'environment';

export interface RuntimeModelConnection {
  url: string;
  model: string;
  apiKey: string;
  timeoutS: number;
  contextTokens: number;
}

export interface RuntimeModelSnapshot extends RuntimeModelConnection {
  profile: RuntimeModelProfile;
  version: string;
  source: RuntimeCredentialSource;
  appliedAt: string;
}

export interface RuntimeModelPublicStatus {
  profile: RuntimeModelProfile;
  state: 'active' | 'missing_credential';
  keyConfigured: boolean;
  source?: RuntimeCredentialSource;
  endpoint?: string;
  model?: string;
  timeoutS?: number;
  contextTokens?: number;
  appliedAt?: string;
  version?: string;
}

export interface RuntimeModelTestInput {
  url: string;
  model: string;
  apiKey: string;
  timeoutS?: number;
  contextTokens?: number;
}

interface RuntimeModelEnvelope {
  schemaVersion: 'anysentry.runtime_model.v1';
  bootId: string;
  profile: RuntimeModelProfile;
  snapshot: RuntimeModelSnapshot | null;
}

interface PendingConnection {
  token: string;
  profile: RuntimeModelProfile;
  connection: RuntimeModelConnection;
  expiresAt: number;
}

export const RUNTIME_MODEL_UPDATE_CHANNEL = 'anysentry:model-runtime:updates:v1';
export const RUNTIME_MODEL_REQUEST_CHANNEL = 'anysentry:model-runtime:requests:v1';
const TEST_TOKEN_TTL_MS = 5 * 60_000;

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function sanitizeEndpoint(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('模型地址不能为空');
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('模型地址必须使用 HTTP 或 HTTPS');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = normalizeLlmBaseUrl(url.pathname) || '/';
  return url.toString().replace(/\/$/u, '');
}

export function sanitizeRuntimeModelConnection(
  input: RuntimeModelTestInput,
  profile: RuntimeModelProfile,
): RuntimeModelConnection {
  const model = typeof input.model === 'string' ? input.model.trim().slice(0, 160) : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim().slice(0, 8_192) : '';
  if (!model) throw new Error('模型名称不能为空');
  if (!apiKey) throw new Error('API Key 不能为空');
  return {
    url: sanitizeEndpoint(input.url),
    model,
    apiKey,
    timeoutS: positiveInt(input.timeoutS, profile === 'fast_review' ? 60 : 90, 1, 600),
    contextTokens: positiveInt(input.contextTokens, profile === 'fast_review' ? 16_384 : 32_768, 4_096, 262_144),
  };
}

function environmentConnection(profile: RuntimeModelProfile, env: NodeJS.ProcessEnv): RuntimeModelConnection | null {
  const deep = profile === 'deep_investigation';
  const url = deep ? env.A3S_SENTRY_L3_URL : env.A3S_SENTRY_LLM_URL;
  const model = deep ? env.A3S_SENTRY_L3_MODEL : env.A3S_SENTRY_LLM_MODEL;
  const apiKey = deep ? env.A3S_SENTRY_L3_KEY : env.A3S_SENTRY_LLM_KEY;
  if (!url?.trim() || !model?.trim() || !apiKey?.trim()) return null;
  try {
    return sanitizeRuntimeModelConnection({
      url,
      model,
      apiKey,
      timeoutS: deep ? Number(env.ANYSENTRY_L3_TIMEOUT_MS) / 1_000 : undefined,
      contextTokens: Number(deep ? env.ANYSENTRY_L3_CONTEXT_TOKENS : env.ANYSENTRY_L2_CONTEXT_TOKENS),
    }, profile);
  } catch {
    return null;
  }
}

function publicStatus(profile: RuntimeModelProfile, snapshot: RuntimeModelSnapshot | null): RuntimeModelPublicStatus {
  if (!snapshot) return { profile, state: 'missing_credential', keyConfigured: false };
  return {
    profile,
    state: 'active',
    keyConfigured: true,
    source: snapshot.source,
    endpoint: snapshot.url,
    model: snapshot.model,
    timeoutS: snapshot.timeoutS,
    contextTokens: snapshot.contextTokens,
    appliedAt: snapshot.appliedAt,
    version: snapshot.version,
  };
}

/** API-side, memory-only credential registry. Redis is used exclusively as non-persistent Pub/Sub. */
@Injectable()
export class RuntimeModelConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly bootId = randomUUID();
  private readonly snapshots = new Map<RuntimeModelProfile, RuntimeModelSnapshot>();
  private readonly pending = new Map<string, PendingConnection>();
  private publisher?: IORedis;
  private subscriber?: IORedis;

  async onModuleInit(): Promise<void> {
    for (const profile of ['fast_review', 'deep_investigation'] as const) {
      const connection = environmentConnection(profile, process.env);
      if (connection) this.snapshots.set(profile, this.snapshot(profile, connection, 'environment'));
    }
    if (process.env.ANYSENTRY_ASYNC_JUDGE !== 'on') return;
    const redisUrl = process.env.ANYSENTRY_REDIS_URL || 'redis://redis:6379/0';
    this.publisher = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.subscriber = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.publisher.on('error', () => undefined);
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('message', (channel, message) => {
      if (channel !== RUNTIME_MODEL_REQUEST_CHANNEL) return;
      if (message !== 'fast_review' && message !== 'deep_investigation') return;
      void this.publish(message);
    });
    await this.subscriber.subscribe(RUNTIME_MODEL_REQUEST_CHANNEL);
    // Clear stale in-worker UI credentials from an older API process, then publish environment
    // compatibility credentials when explicitly configured.
    await Promise.all((['fast_review', 'deep_investigation'] as const).map((profile) => this.publish(profile)));
  }

  async onModuleDestroy(): Promise<void> {
    this.pending.clear();
    this.snapshots.clear();
    if (this.subscriber) await this.subscriber.quit().catch(() => undefined);
    if (this.publisher) await this.publisher.quit().catch(() => undefined);
  }

  get(profile: RuntimeModelProfile): RuntimeModelSnapshot | null {
    return this.snapshots.get(profile) ?? null;
  }

  statuses(): Record<RuntimeModelProfile, RuntimeModelPublicStatus> {
    return {
      fast_review: publicStatus('fast_review', this.get('fast_review')),
      deep_investigation: publicStatus('deep_investigation', this.get('deep_investigation')),
    };
  }

  rememberSuccessfulTest(profile: RuntimeModelProfile, connection: RuntimeModelConnection): { testToken: string; expiresAt: string } {
    this.prunePending();
    const token = randomUUID();
    const expiresAt = Date.now() + TEST_TOKEN_TTL_MS;
    this.pending.set(token, { token, profile, connection, expiresAt });
    return { testToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  consumeSuccessfulTest(profile: RuntimeModelProfile, token: string): RuntimeModelConnection {
    this.prunePending();
    const pending = this.pending.get(token);
    if (!pending || pending.profile !== profile) throw new Error('连接测试已失效，请重新测试后再应用');
    this.pending.delete(token);
    return pending.connection;
  }

  async activate(profile: RuntimeModelProfile, connection: RuntimeModelConnection): Promise<RuntimeModelSnapshot> {
    const snapshot = this.snapshot(profile, connection, 'runtime');
    this.snapshots.set(profile, snapshot);
    await this.publish(profile);
    return snapshot;
  }

  async clear(profile: RuntimeModelProfile): Promise<void> {
    this.snapshots.delete(profile);
    for (const [token, pending] of this.pending) if (pending.profile === profile) this.pending.delete(token);
    await this.publish(profile);
  }

  private snapshot(profile: RuntimeModelProfile, connection: RuntimeModelConnection, source: RuntimeCredentialSource): RuntimeModelSnapshot {
    return { ...connection, profile, source, version: randomUUID(), appliedAt: new Date().toISOString() };
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [token, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(token);
  }

  private async publish(profile: RuntimeModelProfile): Promise<void> {
    if (!this.publisher) return;
    const envelope: RuntimeModelEnvelope = {
      schemaVersion: 'anysentry.runtime_model.v1',
      bootId: this.bootId,
      profile,
      snapshot: this.get(profile),
    };
    await this.publisher.publish(RUNTIME_MODEL_UPDATE_CHANNEL, JSON.stringify(envelope));
  }
}

/** Worker-side memory cache. It never writes credentials into Redis data structures or jobs. */
export class RuntimeModelClient {
  private snapshot: RuntimeModelSnapshot | null;
  private subscriber?: IORedis;
  private publisher?: IORedis;
  private bootId?: string;
  private readonly listeners = new Set<(snapshot: RuntimeModelSnapshot | null) => void>();

  constructor(readonly profile: RuntimeModelProfile, env: NodeJS.ProcessEnv = process.env) {
    const connection = environmentConnection(profile, env);
    this.snapshot = connection ? {
      ...connection,
      profile,
      source: 'environment',
      version: 'environment',
      appliedAt: new Date().toISOString(),
    } : null;
  }

  async initialize(redisUrl = process.env.ANYSENTRY_REDIS_URL || 'redis://redis:6379/0'): Promise<void> {
    this.subscriber = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.publisher = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.subscriber.on('message', (channel, message) => {
      if (channel !== RUNTIME_MODEL_UPDATE_CHANNEL) return;
      let envelope: RuntimeModelEnvelope;
      try { envelope = JSON.parse(message) as RuntimeModelEnvelope; } catch { return; }
      if (envelope.schemaVersion !== 'anysentry.runtime_model.v1' || envelope.profile !== this.profile) return;
      this.bootId = envelope.bootId;
      this.snapshot = envelope.snapshot;
      for (const listener of this.listeners) listener(this.snapshot);
    });
    await this.subscriber.subscribe(RUNTIME_MODEL_UPDATE_CHANNEL);
    await this.publisher.publish(RUNTIME_MODEL_REQUEST_CHANNEL, this.profile);
  }

  get(): RuntimeModelSnapshot | null {
    return this.snapshot;
  }

  onChange(listener: (snapshot: RuntimeModelSnapshot | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.listeners.clear();
    if (this.subscriber) await this.subscriber.quit().catch(() => undefined);
    if (this.publisher) await this.publisher.quit().catch(() => undefined);
  }
}
