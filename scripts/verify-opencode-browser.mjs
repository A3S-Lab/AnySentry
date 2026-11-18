import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const base = process.env.ANYSENTRY_DASHBOARD_URL || 'http://127.0.0.1:29654';
const root = process.env.ANYSENTRY_OPENCODE_TEST_ROOT || '/home/zhongyule/code/anysentry-e2e-work/opencode-20260917';
const report = JSON.parse(await readFile(join(root, 'results/live-report.json'), 'utf8'));
const recordId = report.runs[0].recordId;
const profile = await mkdtemp(join(tmpdir(), 'anysentry-opencode-browser-'));
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
try {
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value => value.type === 'page'); if (target) break; } catch {}
    await sleep(100);
  }
  assert.ok(target);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(), errors = []; let next = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const value = pending.get(message.id); pending.delete(message.id);
      if (message.error) value.reject(new Error(JSON.stringify(message.error))); else value.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  const until = async expression => {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await sleep(200); }
    console.log('Page state', await evaluate(`({url:location.href,text:document.body.innerText.slice(0,1600)})`));
    throw new Error(`Browser condition timed out: ${expression}`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  console.log('Browser connected');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/record-tracking` });
  console.log('Record page navigation sent');
  await until(`Array.from(document.querySelectorAll('button')).some(b => b.innerText.trim() === 'OpenCode')`);
  console.log('OpenCode filter available');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'OpenCode').click()`);
  await until(`document.querySelectorAll('button[aria-label^="打开 OpenCode 会话"]').length >= 3`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button[aria-label^="打开 "]')).every(b => b.getAttribute('aria-label').startsWith('打开 OpenCode 会话'))`), true);
  await writeFile(join(root, 'results/opencode-overview.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await until(`document.documentElement.scrollWidth <= innerWidth + 1`);
  await writeFile(join(root, 'results/opencode-mobile.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/record-tracking?record=${recordId}&view=semantic` });
  await until(`Boolean(document.querySelector('[data-detail-tab="link_awareness"]'))`);
  await evaluate(`document.querySelector('[data-detail-tab="link_awareness"]').click()`);
  await until(`document.body.innerText.includes(${JSON.stringify(report.runs[2].marker)}) && document.querySelectorAll('[data-semantic-kind="tool_call"]').length === 3`);
  assert.equal(await evaluate(`document.body.innerText.includes('OpenCode')`), true);
  assert.equal(await evaluate(`document.querySelectorAll('[data-semantic-turn]').length`), 3);
  await until(`!document.body.innerText.includes('正在加载系统证据') && /候选事件\\s+15/.test(document.body.innerText)`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`), true);
  await writeFile(join(root, 'results/opencode-detail.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  assert.deepEqual(errors, []);
  const result = { pass: true, filter: 'OpenCode', nativeTurns: 3, toolCalls: 3, candidateEvents: 15, runtimeExceptions: errors.length, recordId };
  await writeFile(join(root, 'results/browser-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await send('Browser.close');
} finally {
  socket?.close(); chrome.kill(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}
