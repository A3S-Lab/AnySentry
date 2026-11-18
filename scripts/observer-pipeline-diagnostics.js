'use strict';

const fs = require('node:fs');
const path = require('node:path');

function text(value) {
  return value == null ? '' : String(value).trim();
}

class PipelineDiagnostics {
  constructor(options = {}) {
    this.filePath = options.filePath || '';
    this.maxRecords = options.maxRecords || 1000;
    this.records = [];
    this.lifecycleRecords = [];
    this.filteredLifecycleRecords = [];
    this.dirty = false;
    this.failures = 0;
    this.timer = undefined;
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      this.timer = setInterval(() => this.flush(), options.flushMs || 1000);
      this.timer.unref();
    }
  }

  record(body, stage, reason) {
    if (!this.filePath || !body || typeof body !== 'object') return;
    let observer = body.observerEvent && typeof body.observerEvent === 'object'
      ? body.observerEvent
      : body;
    if (!observer.process && typeof body.line === 'string') {
      try { observer = JSON.parse(body.line); } catch {}
    }
    const process = observer.process && typeof observer.process === 'object' ? observer.process : {};
    const eventKind = text(body.eventKind || body.observerKind || Object.keys(observer.event || {})[0]);
    const entry = {
      at: Date.now(),
      sourceEventId: text(body.sourceEventId),
      eventKind,
      pid: process.pid || observer.event?.ToolExec?.pid || observer.event?.ProcessExit?.pid,
      startTimeNs: text(process.startTimeNs || process.startBoottimeNs || process.start_boottime_ns),
      cgroupId: text(process.cgroupId || process.cgroup_id),
      classification: text(body.classification),
      stage: text(stage),
      reason: text(reason),
    };
    const lifecycle = ['ToolExec', 'ProcessExit', 'SecurityAction', 'CollectorHeartbeat'].includes(eventKind);
    const records = lifecycle
      ? stage === 'filtered' ? this.filteredLifecycleRecords : this.lifecycleRecords
      : this.records;
    records.push(entry);
    if (records.length > this.maxRecords) records.splice(0, records.length - this.maxRecords);
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    const temporary = `${this.filePath}.tmp`;
    try {
      const records = [...this.records, ...this.lifecycleRecords, ...this.filteredLifecycleRecords]
        .sort((left, right) => left.at - right.at);
      fs.writeFileSync(temporary, `${JSON.stringify(records)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      this.dirty = false;
    } catch (error) {
      this.failures++;
      console.error(`[observer-forward] pipeline diagnostics write failed: ${error.message}`);
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.flush();
  }
}

module.exports = { PipelineDiagnostics };
