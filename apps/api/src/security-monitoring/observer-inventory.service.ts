import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AgentClassification, WorkloadIdentitySnapshotEntry } from './types';

/**
 * In-memory receiver for trimmed workload inventories pushed by observation-only
 * forwarders (docker container list plus each container's main-process signature).
 * This is control-plane metadata: nothing here touches the event ingest path,
 * Postgres, or ClickHouse. Entries expire quickly when a source stops reporting,
 * and the observer re-reports after an API restart, so no durability is needed.
 */

export const OBSERVER_INVENTORY_SCHEMA = 'anysentry.observer_inventory.v1' as const;

const MAX_SOURCES = 50;
const MAX_ENTRIES_PER_SOURCE = 500;
const MAX_EVIDENCE = 6;
const MAX_PROCESSES = 4;
const STALE_MS = 10 * 60_000;

export interface ObserverInventoryProcess {
  comm?: string;
  exeBasename?: string;
}

export interface ObserverInventoryPushEntry {
  id?: string;
  containerName?: string;
  containerImage?: string;
  imageDigest?: string;
  containerState?: string;
  classification?: string;
  labels?: Record<string, string>;
  evidence?: string[];
  processes?: ObserverInventoryProcess[];
}

export interface ObserverInventoryPush {
  schemaVersion?: string;
  nodeName?: string;
  generatedAt?: string;
  entries?: ObserverInventoryPushEntry[];
}

interface ObserverInventorySource {
  receivedAt: number;
  nodeName?: string;
  contentHash: string;
  entries: WorkloadIdentitySnapshotEntry[];
}

function text(value: unknown, limit = 160): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized.slice(0, limit) : undefined;
}

function classification(value: unknown): AgentClassification {
  return value === 'confirmed_agent' || value === 'probable_agent' || value === 'non_agent' ? value : 'unknown';
}

function sanitizeLabels(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // Only the platform's own label namespace crosses the wire; arbitrary container
    // labels may carry credentials.
    if (!key.startsWith('anysentry.io/')) continue;
    const item = text(value, 120);
    if (item) labels[key.slice(0, 120)] = item;
    if (Object.keys(labels).length >= 8) break;
  }
  return Object.keys(labels).length ? labels : undefined;
}

function sanitizeProcesses(input: unknown): ObserverInventoryProcess[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const processes = input.slice(0, MAX_PROCESSES)
    .map((item) => ({
      ...(text(item?.comm, 64) ? { comm: text(item.comm, 64) } : {}),
      ...(text(item?.exeBasename, 120) ? { exeBasename: text(item.exeBasename, 120) } : {}),
    }))
    .filter((item) => item.comm || item.exeBasename);
  return processes.length ? processes : undefined;
}

@Injectable()
export class ObserverInventoryService {
  private readonly sources = new Map<string, ObserverInventorySource>();
  private version = 0;

  replace(sourceId: string, input: ObserverInventoryPush): { accepted: number; version: number; unchanged: boolean } {
    const sourceKey = text(sourceId, 160) ?? 'observer';
    if (input?.schemaVersion !== OBSERVER_INVENTORY_SCHEMA) {
      throw new Error(`observer inventory must use ${OBSERVER_INVENTORY_SCHEMA}`);
    }
    if (!this.sources.has(sourceKey) && this.sources.size >= MAX_SOURCES) {
      throw new Error('observer inventory source capacity exceeded');
    }
    const nodeName = text(input.nodeName, 120);
    const entries = (Array.isArray(input.entries) ? input.entries : [])
      .slice(0, MAX_ENTRIES_PER_SOURCE)
      .map((entry) => this.entry(sourceKey, entry))
      .filter((entry): entry is WorkloadIdentitySnapshotEntry => Boolean(entry));
    // Keepalives carry identical content; only real changes bump the snapshot version,
    // so downstream consumers do not recompute on every refresh.
    const contentHash = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    const existing = this.sources.get(sourceKey);
    if (existing && existing.contentHash === contentHash && existing.nodeName === nodeName) {
      existing.receivedAt = Date.now();
      return { accepted: existing.entries.length, version: this.version, unchanged: true };
    }
    this.sources.set(sourceKey, { receivedAt: Date.now(), ...(nodeName ? { nodeName } : {}), contentHash, entries });
    this.version += 1;
    return { accepted: entries.length, version: this.version, unchanged: false };
  }

  private entry(sourceId: string, input: ObserverInventoryPushEntry): WorkloadIdentitySnapshotEntry | undefined {
    const id = text(input.id, 80);
    const containerName = text(input.containerName, 160);
    if (!id && !containerName) return undefined;
    const physicalWorkloadId = `docker:${id ?? containerName}`;
    const evidence = (Array.isArray(input.evidence) ? input.evidence : [])
      .map((item) => text(item, 200))
      .filter((item): item is string => Boolean(item))
      .slice(0, MAX_EVIDENCE);
    const processes = sanitizeProcesses(input.processes);
    const labels = sanitizeLabels(input.labels);
    return {
      ids: [`observer:${sourceId}:${physicalWorkloadId}`],
      classification: classification(input.classification),
      physicalWorkloadId,
      source: 'docker',
      environment: 'docker',
      ...(containerName ? { containerName } : {}),
      ...(text(input.containerImage, 200) ? { containerImage: text(input.containerImage, 200) } : {}),
      ...(labels ? { labels } : {}),
      ...(processes ? { processes } : {}),
      evidence,
    };
  }

  /** Live entries from every source that reported within the staleness window. */
  entries(nodeName?: string): WorkloadIdentitySnapshotEntry[] {
    const now = Date.now();
    const merged: WorkloadIdentitySnapshotEntry[] = [];
    for (const [sourceId, source] of this.sources) {
      if (now - source.receivedAt > STALE_MS) {
        this.sources.delete(sourceId);
        this.version += 1;
        continue;
      }
      if (nodeName && source.nodeName && source.nodeName !== nodeName) continue;
      merged.push(...source.entries);
    }
    return merged;
  }

  snapshotVersion(): number {
    this.entries();
    return this.version;
  }

  metrics(): { sources: number; entries: number; staleDropped: number } {
    const before = this.sources.size;
    const entries = this.entries().length;
    return { sources: this.sources.size, entries, staleDropped: before - this.sources.size };
  }
}
