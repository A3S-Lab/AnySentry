import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Subject } = require('rxjs');
const { HttpShutdown, setHttpShutdownPhase } = await import(`../apps/api/${process.env.ANYSENTRY_TEST_BUILD || 'dist'}/shared/http-shutdown.js`);

class Response extends EventEmitter {
  headers = new Map();
  headersSent = false;
  destroyed = false;
  statusCode = 200;
  body;
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  status(value) { this.statusCode = value; return this; }
  json(value) { this.body = value; this.end(); return this; }
  end() { this.headersSent = true; this.emit('finish'); }
}
const request = (method, originalUrl, accept = '') => ({ method, originalUrl, headers: { accept } });
const gate = new HttpShutdown();
const stream = new Response();
const write = new Response();
gate.middleware(request('GET', '/security-center/sessions/agentObservability/stream?x=1', 'text/event-stream'), stream, () => {});
const writeRequest = request('POST', '/security-center/ingest/batch');
gate.middleware(writeRequest, write, () => {});
setHttpShutdownPhase(writeRequest, 'clickhouse.events-durable');
const work = new Subject();
gate.intercept({ getType: () => 'http', switchToHttp: () => ({ getResponse: () => write }) }, { handle: () => work }).subscribe();
assert.deepEqual(gate.pendingSummary(), [
  { route: 'GET /security-center/sessions/agentObservability/stream [stream]', count: 1 },
  { route: 'POST /security-center/ingest/batch [clickhouse.events-durable]', count: 1 },
]);
write.destroyed = true; // client disconnected; controller is still committing
gate.begin();
assert.equal(stream.headersSent, true, 'Accept-marked stream must end even before Nest writes Content-Type');
assert.equal(gate.pending(), 1, 'disconnected durable handler must remain pending');
const rejected = new Response();
gate.middleware(request('GET', '/health'), rejected, () => assert.fail('draining request reached application'));
assert.equal(rejected.statusCode, 503);
assert.deepEqual(rejected.body, { code: 'SERVICE_DRAINING', retrySafe: true });
work.complete();
assert.equal(gate.pending(), 0);
console.log('PASS: stream Accept, path diagnostics, 503 admission and disconnected durable handler state.');
