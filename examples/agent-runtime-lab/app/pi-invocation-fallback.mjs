import { readFile, unlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const PI_INVOCATION_FALLBACK_SCHEMA = 'anysentry.pi_invocation_fallback.v1';

function text(value, limit) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= limit ? normalized : undefined;
}

export function invocationFallbackPath(pid, env = process.env) {
  const directory = text(env.ANYSENTRY_PI_FALLBACK_DIR, 4_096) ?? '/tmp';
  const safePid = Number.isSafeInteger(Number(pid)) && Number(pid) > 0 ? Number(pid) : process.pid;
  return path.join(directory, `anysentry-pi-invocation-${safePid}.json`);
}

export function writeInvocationFallback(record, pid = process.pid, env = process.env) {
  const payload = JSON.stringify({
    schemaVersion: PI_INVOCATION_FALLBACK_SCHEMA,
    sourceId: record.sourceId,
    sourceType: record.sourceType,
    workspacePath: record.workspacePath,
    event: record.event,
  });
  if (Buffer.byteLength(payload, 'utf8') > 64 * 1024) return false;
  try {
    writeFileSync(invocationFallbackPath(pid, env), payload, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function endpoint(env) {
  const raw = text(env.ANYSENTRY_PI_ADAPTER_URL ?? env.ANYSENTRY_ADAPTER_URL ?? env.ANYSENTRY_INGEST_URL, 2_048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    if (/\/security-center\/ingest\/?$/u.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/ingest\/?$/u, '/ingest/events');
    }
    return url;
  } catch {
    return undefined;
  }
}

async function credential(env) {
  const inline = text(env.ANYSENTRY_ADAPTER_TOKEN ?? env.ANYSENTRY_INGEST_TOKEN, 4_096);
  if (inline) return inline;
  const tokenFile = text(env.ANYSENTRY_ADAPTER_TOKEN_FILE, 4_096);
  if (!tokenFile) return undefined;
  try {
    return text(await readFile(tokenFile, 'utf8'), 4_096);
  } catch {
    return undefined;
  }
}

export async function deliverInvocationFallback(pid, env = process.env, fetchImpl = globalThis.fetch) {
  const pendingPath = invocationFallbackPath(pid, env);
  let document;
  try {
    const raw = await readFile(pendingPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) return { delivered: false, reason: 'fallback_too_large' };
    document = JSON.parse(raw);
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { delivered: false, reason: 'fallback_absent' }
      : { delivered: false, reason: 'fallback_unreadable' };
  }
  const sourceId = text(env.ANYSENTRY_ADAPTER_SOURCE_ID ?? env.ANYSENTRY_SOURCE_ID, 240);
  const token = await credential(env);
  const url = endpoint(env);
  if (
    document?.schemaVersion !== PI_INVOCATION_FALLBACK_SCHEMA
    || !document.event
    || document.sourceId !== sourceId
    || !sourceId
    || !token
    || !url
  ) return { delivered: false, reason: 'fallback_configuration_invalid' };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-anysentry-source-id': sourceId,
        },
        body: JSON.stringify({
          sourceId,
          sourceType: document.sourceType ?? 'custom',
          workspacePath: document.workspacePath,
          events: [document.event],
        }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`fallback ingest returned ${response.status}`);
      const body = await response.json();
      const ack = body?.data ?? body;
      if (ack?.acceptedEvents !== 1 || ack?.items?.[0]?.accepted !== true) {
        throw new Error('fallback ingest acknowledgement invalid');
      }
      await unlink(pendingPath).catch(() => undefined);
      return { delivered: true, eventId: ack.items[0].eventId, attempt };
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  return { delivered: false, reason: 'fallback_delivery_failed' };
}
