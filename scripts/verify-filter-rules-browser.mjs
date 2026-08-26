#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dashboardUrl = (process.env.ANYSENTRY_DASHBOARD_URL ?? 'http://127.0.0.1:32653').replace(/\/$/u, '');
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN ?? '').trim();
const chromeBinary = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const profile = mkdtempSync(path.join(tmpdir(), 'anysentry-filter-rules-chrome-'));
const outputDirectory = path.join(tmpdir(), `anysentry-filter-rules-browser-${process.pid}`);
mkdirSync(outputDirectory, { recursive: true });

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(label, read, accept, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (accept(latest)) return latest;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not converge: ${JSON.stringify(latest)}`);
}

const port = await freePort();
const chrome = spawn(chromeBinary, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeStderr = '';
chrome.stderr.setEncoding('utf8');
chrome.stderr.on('data', (chunk) => { chromeStderr += chunk; });

let socket;
const pending = new Map();
let commandId = 0;
const runtimeExceptions = [];
const failedRequests = [];

try {
  await waitFor('Chrome DevTools endpoint',
    async () => fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok),
    Boolean,
  );
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    .then((response) => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') runtimeExceptions.push(message.params.exceptionDetails?.text ?? 'runtime exception');
    if (message.method === 'Network.loadingFailed' && !message.params.canceled) failedRequests.push(message.params.errorText);
  });

  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed');
    return result.result?.value;
  };
  const navigate = async (pathname) => {
    await command('Page.navigate', { url: `${dashboardUrl}${pathname}` });
    await waitFor('Filter Rules page',
      () => evaluate(`({ ready: [...document.querySelectorAll('h1')].some((heading) => heading.textContent === '过滤规则' || heading.textContent === 'Filter Rules'), loading: document.body.innerText.includes('加载过滤规则') || document.body.innerText.includes('Loading filter rules'), failed: document.body.innerText.includes('过滤规则加载失败') || document.body.innerText.includes('Filter rules failed to load') })`),
      (state) => state?.ready && !state.loading && !state.failed,
      30_000,
    );
  };
  const viewport = async (width, height) => {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  };
  const assertNoOverflow = async (label) => {
    const dimensions = await evaluate(`({ innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth })`);
    assert(dimensions.doc <= dimensions.innerWidth + 1, `${label} document overflow: ${JSON.stringify(dimensions)}`);
    assert(dimensions.body <= dimensions.innerWidth + 1, `${label} body overflow: ${JSON.stringify(dimensions)}`);
  };
  const screenshot = async (name) => {
    const image = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    writeFileSync(path.join(outputDirectory, name), Buffer.from(image.data, 'base64'));
  };
  const waitForAlignedStages = () => waitFor(
    'four aligned filter stages',
    () => evaluate(`(() => { const stage = document.querySelector('section[aria-label="过滤阶段"], section[aria-label="Filter stages"]'); const statuses = stage ? [...stage.querySelectorAll(':scope > div > button')].map((button) => button.innerText) : []; return { statuses, aligned: statuses.length === 4 && statuses.every((status) => /\\bready\\b/i.test(status)) }; })()`),
    (state) => state?.aligned,
    90_000,
  );

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');

  await viewport(1440, 1000);
  await navigate('/filter-rules');
  await waitForAlignedStages();
  const desktop = await evaluate(`({
    title: [...document.querySelectorAll('h1')].find((heading) => heading.textContent === '过滤规则')?.textContent,
    rules: document.body.innerText.match(/(\\d+) 条规则\\s+Catalog/)?.[1],
    stages: ['F0','F1','F2','F3'].every((stage) => document.body.innerText.includes(stage)),
    views: ['按类别','按阶段','按资产/信号'].every((view) => document.body.innerText.includes(view)),
    categoryPanels: document.querySelectorAll('nav[aria-label="规则分类"] section').length
  })`);
  assert.equal(desktop.title, '过滤规则');
  assert.equal(desktop.stages, true);
  assert.equal(desktop.views, true);
  assert(desktop.categoryPanels >= 8);
  await assertNoOverflow('1440 catalog');
  await screenshot('catalog-1440.png');

  assert.equal(await evaluate(`Boolean(document.querySelector('div[aria-label="规则目录"] button')?.click())`), false);
  await waitFor('rule detail route', () => evaluate(`location.search`), (value) => value.includes('ruleId='));
  await waitFor('rule detail data', () => evaluate(`document.querySelectorAll('[role="tab"]').length`), (value) => value === 5);
  const detail = await evaluate(`({ tabs: document.querySelectorAll('[role="tab"]').length, selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, text: document.body.innerText })`);
  assert.equal(detail.tabs, 5);
  assert(detail.text.includes('阶段影响') || detail.text.includes('Stage impact'));
  await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.focus()`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
  const selectedAfterArrow = await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent`);
  assert.notEqual(selectedAfterArrow, detail.selected, 'ArrowRight must move the active detail tab');
  await assertNoOverflow('1440 detail');
  await screenshot('detail-1440.png');

  await viewport(1024, 900);
  await navigate('/filter-rules?view=stage&stage=f2');
  await waitForAlignedStages();
  await assertNoOverflow('1024 stage');
  assert.equal(await evaluate(`document.body.innerText.includes('F2')`), true);
  await screenshot('stage-1024.png');

  await viewport(390, 844);
  await navigate('/filter-rules');
  await waitForAlignedStages();
  await assertNoOverflow('390 catalog');
  await screenshot('catalog-390.png');
  await evaluate(`document.querySelector('div[aria-label="规则目录"] button')?.click()`);
  await waitFor('mobile detail route', () => evaluate(`location.search`), (value) => value.includes('ruleId='));
  await waitFor('mobile detail data', () => evaluate(`document.querySelectorAll('[role="tab"]').length`), (value) => value === 5);
  assert.equal(await evaluate(`document.body.innerText.includes('返回规则目录')`), true);
  await assertNoOverflow('390 detail');
  await screenshot('detail-390.png');

  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
  await evaluate(`localStorage.setItem('anysentry:locale', 'en'); ${adminToken ? `localStorage.setItem('anysentry.adminToken', ${JSON.stringify(adminToken)});` : ''}`);
  await viewport(1440, 1000);
  await navigate('/filter-rules');
  await waitFor('English locale', () => evaluate(`[...document.querySelectorAll('h1')].some((heading) => heading.textContent === 'Filter Rules')`), Boolean);
  await waitForAlignedStages();
  assert.equal(await evaluate(`document.body.innerText.includes('By category') && document.body.innerText.includes('By stage') && document.body.innerText.includes('By asset/signal')`), true);
  await assertNoOverflow('English 1440');
  await screenshot('catalog-en-1440.png');

  assert.deepEqual(runtimeExceptions, [], `browser runtime exceptions: ${runtimeExceptions.join('; ')}`);
  assert.deepEqual(failedRequests, [], `browser network failures: ${failedRequests.join('; ')}`);
  console.log(JSON.stringify({
    dashboardUrl,
    screenshots: outputDirectory,
    viewports: ['1440x1000', '1024x900', '390x844'],
    catalogRules: Number(desktop.rules),
    categoryPanels: desktop.categoryPanels,
    detailTabs: detail.tabs,
    keyboardTabNavigation: true,
    english: true,
    reducedMotion: true,
    horizontalOverflow: false,
    runtimeExceptions: 0,
    networkFailures: 0,
  }, null, 2));
  console.log('PASS Filter Rules browser responsive, keyboard, locale, and reduced-motion verification');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
