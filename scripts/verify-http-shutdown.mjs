import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
require('reflect-metadata');
const { HttpShutdown, shutdownCoordinator } = await import(`../apps/api/${process.env.ANYSENTRY_TEST_BUILD || 'dist'}/shared/http-shutdown.js`);

if (process.argv[2] === '--fixture') {
  const { Controller, Get, Sse, Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { Observable } = require('rxjs');
  let release;
  class FixtureController {
    health() { return { ok: true }; }
    async hold() {
      process.send({ type: 'accepted' });
      await new Promise(resolve => { release = resolve; });
      process.send({ type: 'committed' });
      return { durable: true };
    }
    stream() {
      return new Observable(subscriber => {
        subscriber.next({ data: { ready: true } });
        return () => process.send({ type: 'stream-ended' });
      });
    }
  }
  Controller()(FixtureController);
  for (const name of ['health', 'hold']) Get(name)(FixtureController.prototype, name, Object.getOwnPropertyDescriptor(FixtureController.prototype, name));
  Sse('stream')(FixtureController.prototype, 'stream', Object.getOwnPropertyDescriptor(FixtureController.prototype, 'stream'));
  class FixtureModule {}
  Module({ controllers: [FixtureController] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  const gate = new HttpShutdown();
  app.use(gate.middleware);
  app.useGlobalInterceptors(gate);
  const stop = shutdownCoordinator({ gate, requestMs: 600, closeMs: 600,
    close: async signal => {
      process.send({ type: 'close' });
      if (process.env.CLOSE_HANG === '1') await new Promise(() => {});
      await app.close(signal);
    },
    log: message => process.send({ type: 'log', message }),
    exit: code => process.exit(code),
  });
  process.on('message', message => { if (message === 'release') release?.(); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  process.on('SIGINT', () => { void stop('SIGINT'); });
  await app.listen(0, '127.0.0.1');
  process.send({ type: 'ready', port: app.getHttpServer().address().port });
} else {
  async function fixture(env = {}) {
    const child = fork(fileURLToPath(import.meta.url), ['--fixture'], { env: { ...process.env, ...env }, silent: true });
    const messages = [];
    let error = '';
    child.stderr.on('data', data => { error += data; });
    child.stdout.on('data', data => { error += data; });
    child.on('message', message => messages.push(message));
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, error })));
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 20000);
    exited.finally(() => clearTimeout(watchdog));
    async function wait(type) {
      for (let i = 0; i < 1500; i++) {
        const found = messages.find(m => m.type === type);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`missing ${type}: ${error}`);
    }
    const { port } = await wait('ready');
    return { child, messages, exited, wait, url: `http://127.0.0.1:${port}` };
  }
  // A request accepted before SIGTERM must commit before storage/provider teardown.
  {
    const f = await fixture();
    const response = fetch(`${f.url}/hold`);
    await f.wait('accepted');
    f.child.kill('SIGTERM');
    await f.wait('log');
    const rejected = await fetch(`${f.url}/health`);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('retry-after'), '1');
    assert.equal((await rejected.json()).retrySafe, true);
    f.child.kill('SIGINT'); // repeated signal must not start a second close
    f.child.send('release');
    assert.equal((await (await response).json()).durable, true);
    const exit = await f.exited;
    assert.equal(exit.code, 0, JSON.stringify(exit));
    assert.equal(f.messages.filter(m => m.type === 'close').length, 1);
    assert.ok(f.messages.findIndex(m => m.type === 'committed') < f.messages.findIndex(m => m.type === 'close'));
  }
  // Socket loss cannot release an executing write or produce a false successful drain.
  {
    const f = await fixture();
    const request = http.get(`${f.url}/hold`);
    request.on('error', () => {});
    await f.wait('accepted');
    request.destroy();
    f.child.kill('SIGTERM');
    await f.wait('log');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.messages.some(m => m.type === 'close'), false);
    f.child.send('release');
    assert.equal((await f.exited).code, 0);
  }
  // A genuinely stuck write fails explicitly; it never races storage teardown.
  {
    const f = await fixture();
    const request = fetch(`${f.url}/hold`).catch(() => undefined);
    await f.wait('accepted');
    f.child.kill('SIGTERM');
    assert.equal((await f.exited).code, 1);
    await request;
    assert.equal(f.messages.some(m => m.type === 'close'), false);
    assert.ok(f.messages.some(m => m.message?.includes('INCOMPLETE')));
  }
  {
    const f = await fixture({ CLOSE_HANG: '1' });
    f.child.kill('SIGTERM');
    assert.equal((await f.exited).code, 1);
    assert.ok(f.messages.some(m => m.message?.includes('provider-close')));
  }
  {
    const f = await fixture();
    const response = await fetch(`${f.url}/stream`);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    f.child.kill('SIGTERM');
    await response.text();
    const exit = await f.exited;
    assert.equal(exit.code, 0, JSON.stringify(exit));
    assert.ok(f.messages.some(m => m.type === 'stream-ended'));
  }
  console.log('PASS: real SIGTERM/SIGINT, durable in-flight request, 503 admission, disconnected write, both deadlines and SSE drain.');
}
