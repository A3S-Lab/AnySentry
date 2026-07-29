'use strict';

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

class BoundedPriorityQueue {
  constructor(maxSize, maxPriority = 5) {
    this.maxSize = boundedInteger(maxSize, 4_096, 1, 1_000_000);
    this.maxPriority = boundedInteger(maxPriority, 5, 0, 32);
    this.buckets = Array.from(
      { length: this.maxPriority + 1 },
      () => ({ items: [], head: 0 }),
    );
    this.size = 0;
  }

  get length() {
    return this.size;
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

  clear() {
    const removed = this.size;
    for (const bucket of this.buckets) {
      bucket.items = [];
      bucket.head = 0;
    }
    this.size = 0;
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
    const item = bucket.items[bucket.head++];
    this.size--;
    if (bucket.head >= 1_024 && bucket.head * 2 >= bucket.items.length) {
      bucket.items = bucket.items.slice(bucket.head);
      bucket.head = 0;
    } else if (bucket.head === bucket.items.length) {
      bucket.items = [];
      bucket.head = 0;
    }
    return item;
  }
}

module.exports = { BoundedPriorityQueue };
