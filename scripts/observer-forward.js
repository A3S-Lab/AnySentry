#!/usr/bin/env node
// Bridge a3s-observer NDJSON (stdin) -> AnySentry /ingest. Node stdlib only (apt-free container).
//   a3s-observer-collector | node observer-forward.js
// Target from ANYSENTRY_INGEST_URL (default http://localhost:29653/security-center/ingest).
//
// Backpressure is essential: a busy node emits a firehose of events. We cap in-flight POSTs and
// pause reading when at the cap — so memory stays flat and, under extreme load, the collector
// (which drops on a slow consumer by design) sheds the excess rather than us OOMing.
//
// Noise filter: file access/delete on pseudo-filesystems (/sys cgroup mgmt by systemd/kubelet,
// /proc, runtime dirs) is the dominant volume and never security-relevant for agents. Dropping it
// here focuses the dashboard on real activity and cuts ingest load. Real paths (/home, /etc,
// /workspace, credential files) are kept. Override the prefixes via FORWARD_DROP_PATHS.
const http = require('node:http');
const readline = require('node:readline');

const target = new URL(process.env.ANYSENTRY_INGEST_URL || 'http://localhost:29653/security-center/ingest');
const MAX_INFLIGHT = Number(process.env.FORWARD_MAX_INFLIGHT || 24);
const DROP_PATHS = (process.env.FORWARD_DROP_PATHS || '/sys/,/proc/,/run/,/dev/').split(',').map((s) => s.trim()).filter(Boolean);
const agent = new http.Agent({ keepAlive: true, maxSockets: MAX_INFLIGHT });

let inflight = 0;
const rl = readline.createInterface({ input: process.stdin });

function isNoise(o) {
  const fa = o.event && (o.event.FileAccess || o.event.FileDelete);
  return !!(fa && typeof fa.path === 'string' && DROP_PATHS.some((p) => fa.path.startsWith(p)));
}

rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  let o;
  try { o = JSON.parse(line); } catch { return; } // skip the collector's human log lines / partials
  if (isNoise(o)) return;
  const body = JSON.stringify({ line });

  inflight++;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (--inflight < MAX_INFLIGHT) rl.resume();
  };

  const req = http.request(
    { hostname: target.hostname, port: target.port || 80, path: target.pathname, method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); res.on('end', finish); },
  );
  req.on('error', finish);
  req.setTimeout(5000, () => req.destroy());
  req.end(body);

  if (inflight >= MAX_INFLIGHT) rl.pause(); // stop reading until requests drain
});
