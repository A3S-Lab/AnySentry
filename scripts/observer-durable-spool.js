'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function safeId(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 160) || 'default';
}

function stableWriterId(input) {
  const configured = process.env.ANYSENTRY_WRITER_ID?.trim();
  if (configured) return configured.slice(0, 240);
  const hash = crypto.createHash('sha256');
  for (const value of input) hash.update(String(value || '')).update('\0');
  return `observer-forwarder:${hash.digest('hex').slice(0, 24)}`;
}

class DurableSpool {
  constructor(options = {}) {
    this.writerId = options.writerId || stableWriterId(['observer-forwarder']);
    this.maxRecords = boundedNumber(options.maxRecords, 250_000, 1_000, 5_000_000);
    this.maxBytes = boundedNumber(options.maxBytes, 2 * 1024 * 1024 * 1024, 16 * 1024 * 1024, 64 * 1024 * 1024 * 1024);
    this.fsyncMode = options.fsyncMode === 'always' ? 'always' : 'periodic';
    this.fsyncMs = boundedNumber(options.fsyncMs, 250, 10, 60_000);
    this.compactMinBytes = boundedNumber(options.compactMinBytes, 32 * 1024 * 1024, 1024 * 1024, 4 * 1024 * 1024 * 1024);
    this.compactMaxLiveRecords = boundedNumber(options.compactMaxLiveRecords, 16_384, 1, 250_000);
    this.filePath = path.resolve(options.filePath);
    this.dlqPath = path.resolve(options.dlqPath || `${this.filePath}.dlq`);
    this.records = new Map();
    this.prioritySets = Array.from({ length: 6 }, () => new Set());
    this.logicalBytes = 0;
    this.walBytes = 0;
    this.appendedOperations = 0;
    this.ackedRecords = 0;
    this.deadLetterRecords = 0;
    this.compactionDeferred = 0;
    this.compactions = 0;
    this.closed = false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.load();
    this.fd = fs.openSync(this.filePath, 'a', 0o600);
    this.walBytes = fs.fstatSync(this.fd).size;
    if (this.fsyncMode === 'periodic') {
      this.fsyncTimer = setInterval(() => this.sync(), this.fsyncMs);
      this.fsyncTimer.unref();
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    const contents = fs.readFileSync(this.filePath, 'utf8');
    const lines = contents.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      let operation;
      try {
        operation = JSON.parse(line);
      } catch (error) {
        // A process or host crash can leave only the final append torn. Earlier corruption is not
        // safe to ignore because doing so could silently discard durable evidence.
        if (index === lines.length - 1) break;
        throw new Error(`Observer spool is corrupt at line ${index + 1}: ${error.message}`);
      }
      if (operation.op === 'put' && operation.record?.id && operation.record?.body) {
        const previous = this.records.get(operation.record.id);
        if (previous) {
          this.logicalBytes -= previous.bytes;
          this.prioritySets[previous.priority].delete(previous.id);
        }
        const record = {
          id: String(operation.record.id),
          body: operation.record.body,
          priority: boundedNumber(operation.record.priority, 0, 0, 5),
          queuedAt: boundedNumber(operation.record.queuedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
          bytes: Buffer.byteLength(JSON.stringify(operation.record.body)),
        };
        this.records.set(record.id, record);
        this.prioritySets[record.priority].add(record.id);
        this.logicalBytes += record.bytes;
      } else if (operation.op === 'ack' && Array.isArray(operation.ids)) {
        for (const id of operation.ids) {
          const previous = this.records.get(id);
          if (!previous) continue;
          this.logicalBytes -= previous.bytes;
          this.records.delete(id);
          this.prioritySets[previous.priority].delete(id);
        }
      }
    }
  }

  append(operation, forceSync = false) {
    if (this.closed) throw new Error('Observer spool is closed');
    const line = `${JSON.stringify(operation)}\n`;
    fs.writeSync(this.fd, line);
    this.walBytes += Buffer.byteLength(line);
    this.appendedOperations += 1;
    if (forceSync || this.fsyncMode === 'always') this.sync();
  }

  sync() {
    if (this.closed || this.fd === undefined) return;
    fs.fsyncSync(this.fd);
  }

  put(record) {
    if (!record?.id || !record?.body) throw new Error('Spool record requires id and body');
    if (this.records.has(record.id)) return false;
    const normalized = {
      id: String(record.id),
      body: record.body,
      priority: boundedNumber(record.priority, 0, 0, 5),
      queuedAt: boundedNumber(record.queuedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    };
    const bytes = Buffer.byteLength(JSON.stringify(normalized.body));
    this.append({ op: 'put', record: normalized });
    this.records.set(normalized.id, { ...normalized, bytes });
    this.prioritySets[normalized.priority].add(normalized.id);
    this.logicalBytes += bytes;
    return true;
  }

  ack(ids) {
    const acknowledged = [...new Set(ids)].filter((id) => this.records.has(id));
    if (!acknowledged.length) return 0;
    // Losing an ack append only causes a safe replay after restart. It can never lose the put.
    this.append({ op: 'ack', ids: acknowledged });
    for (const id of acknowledged) {
      const previous = this.records.get(id);
      if (!previous) continue;
      this.logicalBytes -= previous.bytes;
      this.records.delete(id);
      this.prioritySets[previous.priority].delete(id);
    }
    this.ackedRecords += acknowledged.length;
    this.compactIfNeeded();
    return acknowledged.length;
  }

  deadLetter(records, reason) {
    if (!records.length) return 0;
    fs.mkdirSync(path.dirname(this.dlqPath), { recursive: true, mode: 0o700 });
    const lines = records.map((record) => JSON.stringify({
      schemaVersion: 'anysentry.forwarder_dlq.v1',
      rejectedAt: Date.now(),
      writerId: this.writerId,
      reason: String(reason || 'permanent rejection').slice(0, 2_000),
      record,
    })).join('\n') + '\n';
    const fd = fs.openSync(this.dlqPath, 'a', 0o600);
    try {
      fs.writeSync(fd, lines);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.deadLetterRecords += records.length;
    return this.ack(records.map((record) => record.id));
  }

  available(excludedIds, limit) {
    const available = [];
    for (let priority = this.prioritySets.length - 1; priority >= 0; priority -= 1) {
      for (const id of this.prioritySets[priority]) {
        if (excludedIds.has(id)) continue;
        const record = this.records.get(id);
        if (!record) continue;
        available.push(record);
        if (available.length >= limit) return available;
      }
    }
    return available;
  }

  atCapacity() {
    return this.records.size >= this.maxRecords || this.logicalBytes >= this.maxBytes;
  }

  compactIfNeeded() {
    const liveEstimate = this.logicalBytes + this.records.size * 160;
    if (this.walBytes < this.compactMinBytes || this.walBytes < liveEstimate * 2) return false;
    // Rewriting a large live snapshot synchronously would stop the Forwarder from draining the
    // Collector pipe. Defer space reclamation until ACK progress makes the bounded rewrite small;
    // puts and ACKs remain append-only and crash-safe in the meantime.
    if (this.records.size > this.compactMaxLiveRecords) {
      this.compactionDeferred += 1;
      return false;
    }
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      for (const record of this.records.values()) {
        fs.writeSync(fd, `${JSON.stringify({
          op: 'put',
          record: {
            id: record.id,
            body: record.body,
            priority: record.priority,
            queuedAt: record.queuedAt,
          },
        })}\n`);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.filePath);
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = fs.openSync(this.filePath, 'a', 0o600);
    this.walBytes = fs.fstatSync(this.fd).size;
    this.compactions += 1;
    return true;
  }

  status() {
    // Map preserves insertion order. Records are appended in observation order, acknowledgements
    // only delete entries, and compaction writes the same order back. Reading the first live value
    // is therefore the oldest durable record in O(1). The previous full-array reduction ran from
    // every backpressure check and became an O(queue depth) CPU/memory hot path during recovery.
    const oldest = this.records.values().next().value?.queuedAt;
    return {
      writerId: this.writerId,
      filePath: this.filePath,
      records: this.records.size,
      logicalBytes: Math.max(0, this.logicalBytes),
      walBytes: this.walBytes,
      oldestMs: Number.isFinite(oldest) ? Math.max(0, Date.now() - oldest) : 0,
      atCapacity: this.atCapacity(),
      fsyncMode: this.fsyncMode,
      ackedRecords: this.ackedRecords,
      deadLetterRecords: this.deadLetterRecords,
      compactionDeferred: this.compactionDeferred,
      compactions: this.compactions,
      compactMaxLiveRecords: this.compactMaxLiveRecords,
    };
  }

  close() {
    if (this.closed) return;
    if (this.fsyncTimer) clearInterval(this.fsyncTimer);
    this.sync();
    this.closed = true;
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }
}

module.exports = {
  DurableSpool,
  safeId,
  stableWriterId,
};
