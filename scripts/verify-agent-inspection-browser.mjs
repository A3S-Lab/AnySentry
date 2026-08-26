#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dashboardUrl = (process.env.ANYSENTRY_DASHBOARD_URL ?? 'http://127.0.0.1:32653').replace(/\/$/u, '');
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN ?? '').trim();
const chromeBinary = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const profile = mkdtempSync(path.join(tmpdir(), 'anysentry-agent-inspection-chrome-'));
const outputDirectory = path.join(tmpdir(), `anysentry-agent-inspection-${process.pid}`);
mkdirSync(outputDirectory, { recursive: true });

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(label, read, accept, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (accept(latest)) return latest;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label} did not converge: ${JSON.stringify(latest)}`);
}

const port = await freePort();
const chrome = spawn(chromeBinary, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const pending = new Map();
let commandId = 0;
const runtimeExceptions = [];
const failedRequests = [];

try {
  await waitFor('Chrome DevTools endpoint',
    async () => fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok), Boolean);
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(dashboardUrl)}`, { method: 'PUT' })
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
    if (message.method === 'Network.loadingFailed' && !message.params.canceled && message.params.errorText !== 'net::ERR_ABORTED') {
      failedRequests.push(message.params.errorText);
    }
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
  const viewport = (width, height) => command('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 500,
  });
  const navigate = async (pathname, readyText) => {
    await command('Page.navigate', { url: `${dashboardUrl}${pathname}` });
    await waitFor(`${pathname} ready`, () => evaluate(`({ text: document.body?.innerText ?? '', ready: document.readyState })`),
      (state) => state?.ready === 'complete' && state.text.includes(readyText) && !state.text.includes('加载失败'), 60_000);
  };
  const screenshot = async (name) => {
    const image = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    writeFileSync(path.join(outputDirectory, name), Buffer.from(image.data, 'base64'));
  };
  const assertNoOverflow = async (label) => {
    const size = await evaluate(`({ width: innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth })`);
    assert(size.doc <= size.width + 1, `${label} document overflow: ${JSON.stringify(size)}`);
    assert(size.body <= size.width + 1, `${label} body overflow: ${JSON.stringify(size)}`);
  };

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  await waitFor('dashboard origin', () => evaluate('location.origin'), (origin) => origin === new URL(dashboardUrl).origin);
  await evaluate(`localStorage.setItem('anysentry.adminToken', ${JSON.stringify(adminToken)}); localStorage.setItem('anysentry:locale', 'zh-CN')`);

  await viewport(1440, 1000);
  await navigate('/agents?q=k8s-pi-agent-manual&assetRange=current', '智能体资产目录');
  await waitFor('one current Pi row', () => evaluate(`(() => {
    const section = [...document.querySelectorAll('section')].find((node) => node.innerText.includes('智能体资产目录'));
    const rows = section ? [...section.querySelectorAll('button')].filter((button) => button.innerText.includes('k8s-pi-agent-manual')) : [];
    return { count: rows.length, text: document.body.innerText };
  })()`), (state) => state?.count === 1);
  await evaluate(`(() => {
    const section = [...document.querySelectorAll('section')].find((node) => node.innerText.includes('智能体资产目录'));
    [...section.querySelectorAll('button')].find((button) => button.innerText.includes('k8s-pi-agent-manual'))?.click();
  })()`);
  await waitFor('Agent actions', () => evaluate(`({ search: location.search, text: document.body.innerText })`),
    (state) => state?.search.includes('selectedAgentAssetId=') && state.text.includes('Agent 行为追踪')
      && ['read', 'write', 'bash'].every((tool) => state.text.includes(tool)), 60_000);
  const selectedAssetId = await evaluate(`new URLSearchParams(location.search).get('selectedAgentAssetId')`);
  assert(selectedAssetId);
  const assetSelectionBefore = await evaluate('location.search');
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  assert.equal(await evaluate('location.search'), assetSelectionBefore, 'asset polling changed the inspected selection');
  await assertNoOverflow('Agent assets 1440');
  await screenshot('agents-1440.png');

  await viewport(1024, 900);
  await assertNoOverflow('Agent assets 1024');
  await screenshot('agents-1024.png');
  await viewport(390, 844);
  await assertNoOverflow('Agent assets 390');
  await screenshot('agents-390.png');

  await viewport(1440, 1000);
  await navigate(`/events?timeType=last_3h&agentAssetId=${encodeURIComponent(selectedAssetId)}`, '事件检索');
  await waitFor('event rows', () => evaluate(`(() => {
    const section = [...document.querySelectorAll('section')].find((node) => [...node.querySelectorAll('h2')].some((h) => h.textContent === '事件'));
    return section ? [...section.querySelectorAll('button')].filter((button) => button.innerText.trim()).length : 0;
  })()`), (count) => count > 0, 60_000);
  const queryBeforeSelection = await evaluate(`Object.fromEntries(new URLSearchParams(location.search))`);
  await evaluate(`(() => {
    const section = [...document.querySelectorAll('section')].find((node) => [...node.querySelectorAll('h2')].some((h) => h.textContent === '事件'));
    [...section.querySelectorAll('button')].find((button) => button.innerText.trim())?.click();
  })()`);
  const selectedEvent = await waitFor('event inspect mode', () => evaluate(`({ query: Object.fromEntries(new URLSearchParams(location.search)), text: document.body.innerText })`),
    (state) => Boolean(state?.query.eventId) && state.text.includes('检查模式') && state.text.includes('Trace 时间线'), 30_000);
  for (const [key, value] of Object.entries(queryBeforeSelection)) {
    assert.equal(selectedEvent.query[key], value, `event selection rewrote query filter ${key}`);
  }
  assert.equal(Object.keys(selectedEvent.query).filter((key) => !(key in queryBeforeSelection)).join(','), 'eventId');
  const eventId = selectedEvent.query.eventId;
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  assert.equal(await evaluate(`new URLSearchParams(location.search).get('eventId')`), eventId,
    'event polling changed the inspected Event ID');
  await assertNoOverflow('Events 1440');
  await screenshot('events-1440.png');
  await viewport(390, 844);
  await assertNoOverflow('Events 390');
  await screenshot('events-390.png');

  await viewport(1440, 1000);
  await navigate('/filter-rules?ruleId=fr_guardrail_agent_file_read_enable', 'Agent File Read Evidence Enablement');
  const ruleText = await waitFor(
    'selective read rule detail',
    () => evaluate('document.body.innerText'),
    (text) => text.includes('选择性信号启用边界') && text.includes('file_open_read default=not_enabled'),
    30_000,
  );
  assert(ruleText.includes('选择性信号启用边界'));
  assert(ruleText.includes('file_open_read default=not_enabled'));
  assert(ruleText.includes('同 Pod sidecar'));
  await screenshot('read-rule-1440.png');

  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
  assert.deepEqual(runtimeExceptions, [], `browser runtime exceptions: ${runtimeExceptions.join('; ')}`);
  assert.deepEqual(failedRequests, [], `browser network failures: ${failedRequests.join('; ')}`);
  console.log(JSON.stringify({
    dashboardUrl,
    screenshots: outputDirectory,
    viewports: ['1440x1000', '1024x900', '390x844'],
    selectedAssetId,
    selectedEventId: eventId,
    selectionStableAcrossPolling: true,
    querySelectionSeparated: true,
    selectiveReadRuleVisible: true,
    reducedMotion: true,
    horizontalOverflow: false,
    runtimeExceptions: 0,
    networkFailures: 0,
  }, null, 2));
  console.log('PASS Agent/Event inspection browser stability and responsive verification');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
