'use strict';

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

class BoundedPriorityQueue {
  constructor(maxSize, maxPriority = 5, weightOf) {
    this.maxSize = boundedInteger(maxSize, 4_096, 1, 1_000_000);
    this.maxPriority = boundedInteger(maxPriority, 5, 0, 32);
    this.weightOf = typeof weightOf === 'function' ? weightOf : () => 0;
    this.weight = 0;
    this.buckets = Array.from(
      { length: this.maxPriority + 1 },
      () => ({ items: [], head: 0 }),
    );
    this.size = 0;
  }

  get length() {
    return this.size;
  }

  get totalWeight() {
    return this.weight;
  }

  push(item, priority) {
    const normalizedPriority = boundedInteger(priority, 0, 0, this.maxPriority);
    let dropped;
    if (this.size >= this.maxSize) {
      const lowest = this.lowestPriority();
      if (lowest < 0 || normalizedPriority <= lowest) {
        return { accepted: false, dropped: item, droppedIncoming: true };
      }
      dropped = this.takeOne(lowest);
    }
    this.buckets[normalizedPriority].items.push(item);
    this.size++;
    this.weight += this.itemWeight(item);
    return { accepted: true, dropped, droppedIncoming: false };
  }

  take(maxItems) {
    const limit = boundedInteger(maxItems, 1, 1, this.maxSize);
    const result = [];
    for (let priority = this.maxPriority; priority >= 0 && result.length < limit; priority--) {
      while (this.available(priority) > 0 && result.length < limit) {
        result.push(this.takeOne(priority));
      }
    }
    return result;
  }

  takeWeighted(maxItems, maxWeight, weightOf) {
    const limit = boundedInteger(maxItems, 1, 1, this.maxSize);
    const budget = Number.isFinite(maxWeight) && maxWeight > 0 ? maxWeight : Number.MAX_SAFE_INTEGER;
    const weigh = typeof weightOf === 'function' ? weightOf : () => 1;
    const result = [];
    let weight = 0;
    for (let priority = this.maxPriority; priority >= 0 && result.length < limit; priority--) {
      while (this.available(priority) > 0 && result.length < limit) {
        const candidate = this.buckets[priority].items[this.buckets[priority].head];
        const candidateWeight = Math.max(0, Number(weigh(candidate)) || 0);
        // A single oversized item must make progress; callers separately enforce their per-item cap.
        if (result.length > 0 && weight + candidateWeight > budget) return result;
        result.push(this.takeOne(priority));
        weight += candidateWeight;
        if (weight >= budget) return result;
      }
    }
    return result;
  }

  dropLowest() {
    const priority = this.lowestPriority();
    return priority < 0 ? undefined : this.takeOne(priority);
  }

  clear() {
    const removed = this.size;
    for (const bucket of this.buckets) {
      bucket.items = [];
      bucket.head = 0;
    }
    this.size = 0;
    this.weight = 0;
    return removed;
  }

  lowestPriority() {
    for (let priority = 0; priority <= this.maxPriority; priority++) {
      if (this.available(priority) > 0) return priority;
    }
    return -1;
  }

  available(priority) {
    const bucket = this.buckets[priority];
    return bucket.items.length - bucket.head;
  }

  takeOne(priority) {
    const bucket = this.buckets[priority];
    if (bucket.head >= bucket.items.length) return undefined;
    const index = bucket.head++;
    const item = bucket.items[index];
    // Advancing head alone keeps the consumed event body strongly reachable until the next
    // compaction (up to 1,023 slots). Clear ownership immediately so the Forwarder's byte gauge
    // and hard cap also describe the objects retained by this queue.
    bucket.items[index] = undefined;
    this.size--;
    this.weight = Math.max(0, this.weight - this.itemWeight(item));
    if (bucket.head >= 1_024 && bucket.head * 2 >= bucket.items.length) {
      bucket.items = bucket.items.slice(bucket.head);
      bucket.head = 0;
    } else if (bucket.head === bucket.items.length) {
      bucket.items = [];
      bucket.head = 0;
    }
    return item;
  }

  itemWeight(item) {
    return Math.max(0, Number(this.weightOf(item)) || 0);
  }
}

module.exports = { BoundedPriorityQueue };
