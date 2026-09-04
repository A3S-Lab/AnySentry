'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

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
    // `maxBytes` bounds the live logical set; ACK/PUT journal history can temporarily make the
    // physical file larger while compaction is deferred for a large live set. Keep a separate,
    // explicit physical ceiling so a prolonged outage cannot grow the hostPath without bound.
    const defaultMaxWalBytes = Math.min(
      64 * 1024 * 1024 * 1024,
      Math.max(this.maxBytes, this.maxBytes * 2),
    );
    this.maxWalBytes = boundedNumber(
      options.maxWalBytes,
      defaultMaxWalBytes,
      this.maxBytes,
      64 * 1024 * 1024 * 1024,
    );
    this.fsyncMode = options.fsyncMode === 'always' ? 'always' : 'periodic';
    this.fsyncMs = boundedNumber(options.fsyncMs, 250, 10, 60_000);
    this.compactMinBytes = boundedNumber(options.compactMinBytes, 32 * 1024 * 1024, 1024 * 1024, 4 * 1024 * 1024 * 1024);
    this.compactMaxLiveRecords = boundedNumber(options.compactMaxLiveRecords, 16_384, 1, 250_000);
    this.loadChunkBytes = boundedNumber(options.loadChunkBytes, 1024 * 1024, 64, 4 * 1024 * 1024);
    this.maxRecordBytes = boundedNumber(
      options.maxRecordBytes,
      16 * 1024 * 1024,
      64 * 1024,
      64 * 1024 * 1024,
    );
    // A small protected tail lets newly observed lifecycle/security records enter while an old
    // replay backlog is at the ordinary WAL limit. It is still part of the hard bounded budget;
    // low-priority puts cannot consume it.
    this.protectedReserveRecords = boundedNumber(
      options.protectedReserveRecords,
      0,
      0,
      1_000_000,
    );
    this.protectedReserveBytes = boundedNumber(
      options.protectedReserveBytes,
      0,
      0,
      1024 * 1024 * 1024,
    );
    this.writeAsync = options.writeAsync || fs.write.bind(fs);
    this.onAsyncError = typeof options.onAsyncError === 'function' ? options.onAsyncError : () => {};
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
    // Recovered records are represented by a bounded metadata index. Their (potentially very
    // large) JSON bodies stay on disk until replay/compaction actually needs one. This avoids
    // retaining a second ~1 GiB object graph when a node restarts with a full WAL.
    this.lazyRecords = 0;
    this.lazyReads = 0;
    this.lazyReadErrors = 0;
    this.residentBodies = 0;
    this.asyncOperations = [];
    this.pendingWriteBytes = 0;
    this.walCapacityRejects = 0;
    this.asyncWriteActive = false;
    this.pendingPutIds = new Set();
    this.pendingPutBytes = 0;
    this.asyncSyncActive = false;
    this.closed = false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.load();
    this.fd = fs.openSync(this.filePath, 'a', 0o600);
    // Keep a separate read-only descriptor: the append descriptor is intentionally write-only on
    // POSIX, and lazy replay must not reopen the WAL for every record.
    this.readFd = fs.openSync(this.filePath, 'r');
    this.walBytes = fs.fstatSync(this.fd).size;
    if (this.fsyncMode === 'periodic') {
      this.fsyncTimer = setInterval(() => this.syncAsync(), this.fsyncMs);
      this.fsyncTimer.unref();
    }
  }

  applyLoadedOperation(operation, walOffset, walLineBytes) {
    if (operation.op === 'put' && operation.record?.id && operation.record?.body) {
      const previous = this.records.get(operation.record.id);
      if (previous) {
        this.logicalBytes -= previous.bytes;
        this.prioritySets[previous.priority].delete(previous.id);
        if (previous._lazyBody === true && previous._bodyLoaded !== true) {
          this.lazyRecords = Math.max(0, this.lazyRecords - 1);
        } else {
          this.residentBodies = Math.max(0, this.residentBodies - 1);
        }
      }
      const record = {
        id: String(operation.record.id),
        priority: boundedNumber(operation.record.priority, 0, 0, 5),
        queuedAt: boundedNumber(operation.record.queuedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
        bytes: Buffer.byteLength(JSON.stringify(operation.record.body)),
      };
      if (Number.isSafeInteger(walOffset) && walOffset >= 0 && Number.isSafeInteger(walLineBytes) && walLineBytes > 0) {
        this.attachLazyBody(record, walOffset, walLineBytes);
        this.lazyRecords += 1;
      } else {
        record.body = operation.record.body;
        record._bodyLoaded = true;
        this.residentBodies += 1;
      }
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
        if (previous._lazyBody === true && previous._bodyLoaded !== true) {
          this.lazyRecords = Math.max(0, this.lazyRecords - 1);
        } else {
          this.residentBodies = Math.max(0, this.residentBodies - 1);
        }
      }
    }
  }

  attachLazyBody(record, walOffset, walLineBytes) {
    const owner = this;
    Object.defineProperties(record, {
      _lazyBody: { value: true, writable: true, enumerable: false, configurable: true },
      _bodyLoaded: { value: false, writable: true, enumerable: false, configurable: true },
      _bodyValue: { value: undefined, writable: true, enumerable: false, configurable: true },
      _walOffset: { value: walOffset, writable: true, enumerable: false, configurable: true },
      _walLineBytes: { value: walLineBytes, writable: true, enumerable: false, configurable: true },
    });
    Object.defineProperty(record, 'body', {
      enumerable: true,
      configurable: true,
      get() {
        if (!record._bodyLoaded) {
          record._bodyValue = owner.readLazyBody(record);
          record._bodyLoaded = true;
          owner.lazyRecords = Math.max(0, owner.lazyRecords - 1);
          owner.residentBodies += 1;
        }
        return record._bodyValue;
      },
      set(value) {
        if (!record._bodyLoaded) {
          owner.lazyRecords = Math.max(0, owner.lazyRecords - 1);
          owner.residentBodies += 1;
        }
        record._bodyValue = value;
        record._bodyLoaded = true;
      },
    });
  }

  readLazyBody(record) {
    this.lazyReads += 1;
    try {
      const lineBytes = Number(record._walLineBytes);
      if (!Number.isSafeInteger(lineBytes) || lineBytes <= 0 || lineBytes > this.maxRecordBytes) {
        throw new Error(`Observer spool record exceeds bounded read size (${lineBytes} bytes)`);
      }
      const buffer = Buffer.allocUnsafe(lineBytes);
      const bytesRead = fs.readSync(this.readFd, buffer, 0, lineBytes, record._walOffset);
      const line = buffer.subarray(0, bytesRead).toString('utf8').replace(/\n$/u, '');
      const operation = JSON.parse(line);
      if (operation.op !== 'put' || String(operation.record?.id || '') !== record.id || !operation.record?.body) {
        throw new Error(`Observer spool record ${record.id} changed at WAL offset ${record._walOffset}`);
      }
      return operation.record.body;
    } catch (error) {
      this.lazyReadErrors += 1;
      throw new Error(`Observer spool record ${record.id} could not be read: ${error.message}`);
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    const fd = fs.openSync(this.filePath, 'r');
    const buffer = Buffer.allocUnsafe(this.loadChunkBytes);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    // `pendingOffset` is the byte offset of the first decoded character currently in `pending`.
    // Buffer.byteLength(line) keeps the index correct for UTF-8 records split across chunks.
    let pendingOffset = 0;
    let lineNumber = 0;
    const applyLine = (line, offset, lineBytes) => {
      lineNumber += 1;
      if (!line) return;
      try {
        this.applyLoadedOperation(JSON.parse(line), offset, lineBytes);
      } catch (error) {
        throw new Error(`Observer spool is corrupt at line ${lineNumber}: ${error.message}`);
      }
    };
    try {
      while (true) {
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (bytes === 0) break;
        pending += decoder.write(buffer.subarray(0, bytes));
        let start = 0;
        while (true) {
          const newline = pending.indexOf('\n', start);
          if (newline < 0) break;
          const line = pending.slice(start, newline);
          const lineBytes = Buffer.byteLength(line) + 1;
          applyLine(line, pendingOffset, lineBytes);
          pendingOffset += lineBytes;
          start = newline + 1;
        }
        pending = pending.slice(start);
      }
      pending += decoder.end();
      if (pending) {
        // A process or host crash can leave only the final, non-newline-terminated append torn.
        // A complete final operation is still applied; malformed trailing bytes are ignored.
        try {
          this.applyLoadedOperation(JSON.parse(pending), pendingOffset, Buffer.byteLength(pending));
        } catch {
          // Safe replay boundary: every preceding newline-terminated operation was validated.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  operationBytes(operation) {
    return Buffer.byteLength(`${JSON.stringify(operation)}\n`);
  }

  canAppend(bytes) {
    const size = Number(bytes);
    return Number.isSafeInteger(size) && size >= 0
      && this.walBytes + this.pendingWriteBytes + size <= this.maxWalBytes;
  }

  walCapacityError(bytes) {
    this.walCapacityRejects += 1;
    return Object.assign(new Error('Observer spool physical WAL capacity reached'), {
      code: 'ANYSENTRY_SPOOL_WAL_CAPACITY',
      maxWalBytes: this.maxWalBytes,
      requestedBytes: Number(bytes) || 0,
      walBytes: this.walBytes,
      pendingWriteBytes: this.pendingWriteBytes,
    });
  }

  atWalCapacity() {
    return this.walBytes + this.pendingWriteBytes >= this.maxWalBytes;
  }

  append(operation, forceSync = false) {
    if (this.closed) throw new Error('Observer spool is closed');
    const line = `${JSON.stringify(operation)}\n`;
    if (!this.canAppend(Buffer.byteLength(line))) {
      throw this.walCapacityError(Buffer.byteLength(line));
    }
    fs.writeSync(this.fd, line);
    this.walBytes += Buffer.byteLength(line);
    this.appendedOperations += 1;
    if (forceSync || this.fsyncMode === 'always') this.sync();
  }

  appendAsync(operation, forceSync, done) {
    if (this.closed) {
      done(new Error('Observer spool is closed'));
      return;
    }
    const buffer = Buffer.from(`${JSON.stringify(operation)}\n`);
    if (!this.canAppend(buffer.length)) {
      queueMicrotask(() => done(this.walCapacityError(buffer.length)));
      return;
    }
    this.pendingWriteBytes += buffer.length;
    this.asyncOperations.push({ buffer, offset: 0, forceSync, done });
    this.pumpAsyncWrites();
  }

  pumpAsyncWrites() {
    if (this.asyncWriteActive || this.closed) return;
    const entry = this.asyncOperations[0];
    if (!entry) return;
    this.asyncWriteActive = true;
    const finish = (error) => {
      this.asyncWriteActive = false;
      this.asyncOperations.shift();
      this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - entry.buffer.length);
      if (!error) {
        this.walBytes += entry.buffer.length;
        this.appendedOperations += 1;
      }
      try {
        entry.done(error);
      } finally {
        if (error && error.code !== 'ANYSENTRY_SPOOL_WAL_CAPACITY') this.onAsyncError(error);
        this.pumpAsyncWrites();
      }
    };
    const writeRemaining = () => {
      this.writeAsync(
        this.fd,
        entry.buffer,
        entry.offset,
        entry.buffer.length - entry.offset,
        null,
        (error, written = 0) => {
          if (error) {
            finish(error);
            return;
          }
          if (written <= 0) {
            finish(new Error('Observer spool async append made no progress'));
            return;
          }
          entry.offset += written;
          if (entry.offset < entry.buffer.length) {
            writeRemaining();
            return;
          }
          if (entry.forceSync || this.fsyncMode === 'always') {
            fs.fsync(this.fd, finish);
          } else {
            finish();
          }
        },
      );
    };
    writeRemaining();
  }

  sync() {
    if (this.closed || this.fd === undefined) return;
    fs.fsyncSync(this.fd);
  }

  syncAsync() {
    if (this.closed || this.fd === undefined || this.asyncSyncActive) return;
    this.asyncSyncActive = true;
    fs.fsync(this.fd, (error) => {
      this.asyncSyncActive = false;
      if (error) this.onAsyncError(error);
    });
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
    this.residentBodies += 1;
    return true;
  }

  putAsync(record, done) {
    if (!record?.id || !record?.body) {
      done(new Error('Spool record requires id and body'));
      return;
    }
    const id = String(record.id);
    if (this.records.has(id) || this.pendingPutIds.has(id)) {
      queueMicrotask(() => done(undefined, false));
      return;
    }
    const normalized = {
      id,
      body: record.body,
      priority: boundedNumber(record.priority, 0, 0, 5),
      queuedAt: boundedNumber(record.queuedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    };
    const bytes = Buffer.byteLength(JSON.stringify(normalized.body));
    const protectedPriority = normalized.priority >= 3;
    const recordLimit = this.maxRecords + (protectedPriority ? this.protectedReserveRecords : 0);
    const byteLimit = this.maxBytes + (protectedPriority ? this.protectedReserveBytes : 0);
    const operation = { op: 'put', record: normalized };
    const operationBytes = this.operationBytes(operation);
    if (
      this.records.size + this.pendingPutIds.size + 1 > recordLimit
      || this.logicalBytes + this.pendingPutBytes + bytes > byteLimit
      || !this.canAppend(operationBytes)
    ) {
      queueMicrotask(() => done(
        this.canAppend(operationBytes)
          ? Object.assign(new Error('Observer spool capacity reached'), {
              code: 'ANYSENTRY_SPOOL_CAPACITY',
            })
          : this.walCapacityError(operationBytes),
      ));
      return;
    }
    this.pendingPutIds.add(id);
    this.pendingPutBytes += bytes;
    this.appendAsync(operation, false, (error) => {
      this.pendingPutIds.delete(id);
      this.pendingPutBytes = Math.max(0, this.pendingPutBytes - bytes);
      if (error) {
        done(error);
        return;
      }
      this.records.set(id, { ...normalized, bytes });
      this.prioritySets[normalized.priority].add(id);
      this.logicalBytes += bytes;
      this.residentBodies += 1;
      done(undefined, true);
    });
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
      if (previous._lazyBody === true && previous._bodyLoaded !== true) {
        this.lazyRecords = Math.max(0, this.lazyRecords - 1);
      } else {
        this.residentBodies = Math.max(0, this.residentBodies - 1);
      }
    }
    this.ackedRecords += acknowledged.length;
    this.compactIfNeeded();
    return acknowledged.length;
  }

  ackAsync(ids, done = () => {}) {
    const acknowledged = [...new Set(ids)].filter((id) => this.records.has(id));
    if (!acknowledged.length) {
      queueMicrotask(() => done(undefined, 0));
      return 0;
    }
    const operation = { op: 'ack', ids: acknowledged };
    const operationBytes = this.operationBytes(operation);
    if (!this.canAppend(operationBytes)) {
      queueMicrotask(() => done(this.walCapacityError(operationBytes), 0));
      return 0;
    }
    const removed = [];
    for (const id of acknowledged) {
      const previous = this.records.get(id);
      if (!previous) continue;
      removed.push(previous);
      this.logicalBytes -= previous.bytes;
      this.records.delete(id);
      this.prioritySets[previous.priority].delete(id);
      if (previous._lazyBody === true && previous._bodyLoaded !== true) {
        this.lazyRecords = Math.max(0, this.lazyRecords - 1);
      } else {
        this.residentBodies = Math.max(0, this.residentBodies - 1);
      }
    }
    this.appendAsync(operation, false, (error) => {
      if (error) {
        // The durable put still exists. Restore the in-memory live view so later replay is safe.
        for (const record of removed) {
          if (this.records.has(record.id)) continue;
          this.records.set(record.id, record);
          this.prioritySets[record.priority].add(record.id);
          this.logicalBytes += record.bytes;
          if (record._lazyBody === true && record._bodyLoaded !== true) {
            this.lazyRecords += 1;
          } else {
            this.residentBodies += 1;
          }
        }
        done(error, 0);
        return;
      }
      this.ackedRecords += acknowledged.length;
      this.compactIfNeeded();
      done(undefined, acknowledged.length);
    });
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
    try {
      return this.ack(records.map((record) => record.id));
    } catch (error) {
      // The DLQ write is durable even when the ACK journal has reached its physical ceiling. Keep
      // the live WAL records for a later retry instead of crashing or silently deleting them.
      if (error?.code === 'ANYSENTRY_SPOOL_WAL_CAPACITY') return 0;
      throw error;
    }
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

  defer(ids) {
    let deferred = 0;
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) continue;
      const lane = this.prioritySets[record.priority];
      if (!lane.delete(id)) continue;
      lane.add(id);
      deferred += 1;
    }
    return deferred;
  }

  atCapacity(priority = 0) {
    if (this.atWalCapacity()) return true;
    const protectedPriority = Number(priority) >= 3;
    const recordLimit = this.maxRecords + (protectedPriority ? this.protectedReserveRecords : 0);
    const byteLimit = this.maxBytes + (protectedPriority ? this.protectedReserveBytes : 0);
    return this.records.size + this.pendingPutIds.size >= recordLimit
      || this.logicalBytes + this.pendingPutBytes >= byteLimit;
  }

  compactIfNeeded() {
    const liveEstimate = this.logicalBytes + this.records.size * 160;
    if (this.walBytes < this.compactMinBytes || this.walBytes < liveEstimate * 2) return false;
    // Rewriting a large live snapshot synchronously would stop the Forwarder from draining the
    // Collector pipe. Defer space reclamation until ACK progress makes the bounded rewrite small;
    // puts and ACKs remain append-only and crash-safe in the meantime.
    if (
      this.records.size > this.compactMaxLiveRecords
      || this.asyncWriteActive
      || this.asyncOperations.length > 0
      || this.asyncSyncActive
    ) {
      this.compactionDeferred += 1;
      return false;
    }
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      for (const record of this.records.values()) {
        // Materialize at most the bounded live set allowed by compactMaxLiveRecords. The normal
        // full-WAL recovery path is therefore lazy; compaction is the explicit point where bodies
        // are read, rewritten and (necessarily) resident for the short write window.
        const body = record.body;
        fs.writeSync(fd, `${JSON.stringify({
          op: 'put',
          record: {
            id: record.id,
            body,
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
    if (this.readFd !== undefined) fs.closeSync(this.readFd);
    this.readFd = fs.openSync(this.filePath, 'r');
    this.walBytes = fs.fstatSync(this.fd).size;
    // Existing records have already been materialized while writing the compacted snapshot. Drop
    // stale offsets and keep the bounded body cache as the new source of truth.
    for (const record of this.records.values()) {
      if (record._lazyBody === true && record._bodyLoaded !== true) {
        // This branch is defensive: a read failure above throws before the rename. It keeps the
        // index counters coherent if a future writer implementation changes that ordering.
        this.lazyRecords = Math.max(0, this.lazyRecords - 1);
        this.residentBodies += 1;
        record._bodyLoaded = true;
      }
      if (record._lazyBody === true) {
        record._lazyBody = false;
        record._walOffset = undefined;
        record._walLineBytes = undefined;
      }
    }
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
      pendingPutRecords: this.pendingPutIds.size,
      pendingPutBytes: this.pendingPutBytes,
      pendingOperations: this.asyncOperations.length,
      asyncSyncActive: this.asyncSyncActive,
      logicalBytes: Math.max(0, this.logicalBytes),
      walBytes: this.walBytes,
      oldestMs: Number.isFinite(oldest) ? Math.max(0, Date.now() - oldest) : 0,
      atCapacity: this.atCapacity(),
      atWalCapacity: this.atWalCapacity(),
      maxWalBytes: this.maxWalBytes,
      pendingWriteBytes: this.pendingWriteBytes,
      walCapacityRejects: this.walCapacityRejects,
      fsyncMode: this.fsyncMode,
      ackedRecords: this.ackedRecords,
      deadLetterRecords: this.deadLetterRecords,
      compactionDeferred: this.compactionDeferred,
      compactions: this.compactions,
      compactMaxLiveRecords: this.compactMaxLiveRecords,
      maxRecordBytes: this.maxRecordBytes,
      maxRecords: this.maxRecords,
      maxBytes: this.maxBytes,
      protectedReserveRecords: this.protectedReserveRecords,
      protectedReserveBytes: this.protectedReserveBytes,
      lazyRecords: this.lazyRecords,
      lazyReads: this.lazyReads,
      lazyReadErrors: this.lazyReadErrors,
      residentBodies: this.residentBodies,
    };
  }

  prepareClose() {
    if (this.fsyncTimer) clearInterval(this.fsyncTimer);
    this.fsyncTimer = undefined;
  }

  close() {
    if (this.closed) return;
    this.prepareClose();
    if (this.asyncWriteActive || this.asyncOperations.length > 0 || this.asyncSyncActive) {
      throw new Error('Observer spool closed with pending async operations');
    }
    this.sync();
    this.closed = true;
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
    if (this.readFd !== undefined) fs.closeSync(this.readFd);
    this.readFd = undefined;
  }
}

module.exports = {
  DurableSpool,
  safeId,
  stableWriterId,
};
