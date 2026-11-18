// Synthetic timeline records in an isolated browser; no stored Session or collector writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.ANYSENTRY_WEB_TEST_URL ?? 'http://127.0.0.1:5173';
const recordId = 'd11e7897d0401de8daa0bd33';
const res = await fetch(`http://127.0.0.1:29653/security-center/local-records/${recordId}?limit=1&includeSystemEvidence=false&includeObservedLlmRequests=false`, { signal: AbortSignal.timeout(20000) });
assert.ok(res.ok);
const fixture = await res.json();
const kinds = ['user_message', 'assistant_message', 'tool_call', 'tool_result', 'turn_start', 'turn_complete', 'tool_result'];
const titles = ['用户指令', 'Agent 回复', '调用 exec', 'exec结果', 'Turn 开始', 'Turn 完成', 'exec结果'];
fixture.data.events = kinds.map((kind, i) => ({
  eventId: `collapse-${i}`, kind, title: titles[i], timestamp: 1789374000000 + i * 1000,
  content: `FIRST_${i}\n${'long unmodified content '.repeat(200)}\nLAST_${i}`,
  command: i === 2 ? 'printf "original command"\nprintf "second line"' : undefined,
  toolName: kind.startsWith('tool_') ? 'exec' : undefined,
  turnId: 'collapse-turn', sourceOffset: i, phase: i === 1 ? 'commentary' : undefined,
  status: i === 6 ? 'failure' : undefined,
}));
fixture.data.page.hasMore = false;
fixture.data.page.returnedEvents = kinds.length;
fixture.data.observedLlmRequests = [];
const profile = await mkdtemp(path.join(os.tmpdir(), 'anysentry-timeline-collapse-'));
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
    await delay(100);
  }
  assert.ok(port);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let next = 0;
  const pending = new Map();
  const exceptions = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(m.error.message)) : p?.resolve(m.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.text);
    return result.result.value;
  };
  const until = async expression => { for (let i = 0; i < 200; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(100); } throw new Error(`Timed out: ${expression}`); };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalFetch = window.fetch.bind(window);
    const fixture = ${JSON.stringify(fixture)};
    window.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/security-center/local-records/${recordId}') return Promise.resolve(new Response(JSON.stringify(fixture), {headers:{'Content-Type':'application/json'}}));
      return originalFetch(input, options);
    };` });
  await send('Page.navigate', { url: `${base}/record-tracking?record=${recordId}` });
  await until(`document.querySelector('[data-detail-tab="timeline"]')`);
  await evaluate(`document.querySelector('[data-detail-tab="timeline"]').click()`);
  await until(`document.querySelectorAll('[data-timeline-event]').length === 7`);
  const rows = `Array.from(document.querySelectorAll('[data-timeline-event]'))`;
  assert.ok(await evaluate(`${rows}.every(r => r.querySelector('button').getAttribute('aria-expanded') === 'false' && !r.querySelector('pre') && r.getBoundingClientRect().height <= 50)`));
  assert.deepEqual(await evaluate(`${rows}.map(r => r.querySelector('button > span.font-semibold, button > span.text-xs.font-semibold')?.textContent)`), titles);
  for (let i = 0; i < kinds.length; i++) {
    await evaluate(`${rows}[${i}].querySelector('button').click()`);
    assert.ok(await evaluate(`${rows}[${i}].querySelector('pre') && ${rows}[${i}].textContent.includes('LAST_${i}')`));
    await evaluate(`${rows}[${i}].querySelector('button').click()`);
  }
  await evaluate(`${rows}[2].querySelector('button').focus()`);
  assert.ok(await evaluate(`document.activeElement === ${rows}[2].querySelector('button')`));
  for (const [key, code, vk] of [['Enter', 'Enter', 13], [' ', 'Space', 32]]) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key === 'Enter' ? '\r' : ' ' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await delay(100);
    assert.equal(await evaluate(`${rows}[2].querySelector('button').getAttribute('aria-expanded')`), key === 'Enter' ? 'true' : 'false');
  }
  assert.equal(await evaluate(`${rows}[2].querySelector('button').getAttribute('aria-expanded')`), 'false');
  await evaluate(`${rows}[2].querySelector('button').click(); [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '刷新').at(-1).click()`);
  await delay(700);
  assert.equal(await evaluate(`${rows}[2].querySelector('button').getAttribute('aria-expanded')`), 'true');
  assert.equal(await evaluate(`${rows}[2].querySelector('pre').textContent.trim()`), fixture.data.events[2].command);
  await evaluate(`${rows}[2].querySelector('button').click()`);
  await writeFile(path.join(profile, 'timeline-desktop.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
  await delay(200);
  assert.ok(await evaluate(`${rows}.every(r => r.scrollWidth <= r.clientWidth + 2 && r.getBoundingClientRect().height <= 50)`));
  await evaluate(`${rows}[2].querySelector('button').click()`);
  assert.ok(await evaluate(`${rows}[2].scrollWidth <= ${rows}[2].clientWidth + 2`));
  await evaluate(`${rows}[2].scrollIntoView({block:'start'})`);
  await writeFile(path.join(profile, 'timeline-mobile.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  await evaluate(`document.querySelector('[data-detail-tab="tools"]').click()`);
  await until(`document.querySelectorAll('[data-timeline-event]').length === 3`);
  assert.ok(await evaluate(`${rows}.every(r => r.textContent.includes('exec'))`));
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ pass: true, checks: ['all 7 rows collapsed', 'original titles and full text retained', 'click all event kinds', 'Enter and Space', 'refresh preserves expansion', '375px single-line/no card overflow', 'tools tab'], screenshots: profile }));
  await send('Browser.close');
} finally { ws?.close(); chrome.kill('SIGTERM'); }
