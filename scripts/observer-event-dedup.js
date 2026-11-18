'use strict';

const DEFAULT_WINDOW_MS = 5000;
const DEFAULT_MAX_KEYS = 20_000;

class ToolExecDeduper {
  constructor(options = {}) {
    this.windowMs = Math.max(0, Number(options.windowMs ?? DEFAULT_WINDOW_MS));
    this.maxKeys = Math.max(1000, Number(options.maxKeys ?? DEFAULT_MAX_KEYS));
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.recent = new Map();
  }

  isDuplicate(observerEvent) {
    if (!this.windowMs) return false;
    const tool = observerEvent?.event?.ToolExec;
    if (!tool || typeof tool !== 'object') return false;
    const processInfo = observerEvent?.process && typeof observerEvent.process === 'object' ? observerEvent.process : {};
    const pid = Number(tool.pid ?? processInfo.pid ?? observerEvent?.identity?.task);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const ppid = Number(tool.ppid ?? processInfo.ppid) || 0;
    const argv = Array.isArray(tool.argv) ? tool.argv.map(String) : [String(tool.argv ?? '')];
    const cwd = typeof tool.cwd === 'string' ? tool.cwd : '';
    const key = JSON.stringify([pid, ppid, argv, cwd]);
    const now = this.now();
    const quality = [
      tool.exec_confirmed === true ? 1 : 0,
      tool.argv_incomplete === true ? 0 : 1,
      tool.argv_truncated === true ? 0 : 1,
    ];
    const previous = this.recent.get(key);
    this.recent.set(key, { seenAt: now, quality });

    if (this.recent.size > this.maxKeys) {
      const cutoff = now - this.windowMs;
      for (const [candidate, seen] of this.recent) {
        if (seen.seenAt < cutoff) this.recent.delete(candidate);
      }
      if (this.recent.size > this.maxKeys) this.recent.clear();
    }
    if (!previous || now - previous.seenAt > this.windowMs) return false;
    for (let index = 0; index < quality.length; index++) {
      if (quality[index] > previous.quality[index]) return false;
      if (quality[index] < previous.quality[index]) return true;
    }
    return true;
  }
}

module.exports = { ToolExecDeduper };
