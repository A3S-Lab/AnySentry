export interface FactCacheBudgetSnapshot {
  buckets: number;
  facts: number;
  estimatedBytes: number;
  evictions: number;
  budgetRejects: number;
  journalResets: number;
}

interface BucketWeight {
  facts: number;
  estimatedBytes: number;
}

/**
 * Tracks the retained weight of an in-process fact cache.
 *
 * Bucket count alone is not a memory bound: one high-cardinality bucket can contain thousands of
 * Agent, Workspace or topology rows. The byte estimate deliberately includes JSON payload size
 * and a small per-object allowance. It is not a V8 heap measurement, but it provides a stable,
 * conservative admission limit without sampling or dropping facts from a successful query.
 */
export class FactCacheBudget {
  private readonly weights = new Map<number, BucketWeight>();
  private facts = 0;
  private estimatedBytes = 0;
  private evictions = 0;
  private budgetRejects = 0;
  private journalResets = 0;

  constructor(
    readonly maxBuckets: number,
    readonly maxFacts: number,
    readonly maxEstimatedBytes: number,
  ) {}

  record(bucketStartMs: number, rows: unknown[]): void {
    this.remove(bucketStartMs, false);
    const weight = {
      facts: rows.length,
      estimatedBytes: estimateRowsBytes(rows),
    };
    this.weights.set(bucketStartMs, weight);
    this.facts += weight.facts;
    this.estimatedBytes += weight.estimatedBytes;
  }

  remove(bucketStartMs: number, eviction = true): void {
    const previous = this.weights.get(bucketStartMs);
    if (!previous) return;
    this.weights.delete(bucketStartMs);
    this.facts = Math.max(0, this.facts - previous.facts);
    this.estimatedBytes = Math.max(0, this.estimatedBytes - previous.estimatedBytes);
    if (eviction) this.evictions += 1;
  }

  clear(reason: 'budget' | 'journal' | 'manual'): void {
    this.weights.clear();
    this.facts = 0;
    this.estimatedBytes = 0;
    if (reason === 'budget') this.budgetRejects += 1;
    if (reason === 'journal') this.journalResets += 1;
  }

  exceeded(): boolean {
    return (
      this.weights.size > this.maxBuckets ||
      this.facts > this.maxFacts ||
      this.estimatedBytes > this.maxEstimatedBytes
    );
  }

  snapshot(): FactCacheBudgetSnapshot {
    return {
      buckets: this.weights.size,
      facts: this.facts,
      estimatedBytes: this.estimatedBytes,
      evictions: this.evictions,
      budgetRejects: this.budgetRejects,
      journalResets: this.journalResets,
    };
  }
}

function estimateRowsBytes(rows: unknown[]): number {
  let bytes = rows.length * 64;
  for (const row of rows) {
    try {
      bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
    } catch {
      // Facts are expected to be plain serialisable rows. If a future fact is not serialisable,
      // charge a conservative fixed amount instead of allowing it to bypass the memory budget.
      bytes += 4_096;
    }
  }
  return bytes;
}
