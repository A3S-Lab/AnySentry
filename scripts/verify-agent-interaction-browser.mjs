#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { managementAuthHeaders } from './probe-id.mjs';

const apiBase = (process.env.ANYSENTRY_API_BASE
  ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/u, '');
const dashboardUrl = (process.env.ANYSENTRY_DASHBOARD_URL
  ?? apiBase.replace(/\/security-center$/u, '')).replace(/\/$/u, '');
const marker = process.env.ANYSENTRY_E2E_INTERACTION_MARKER
  ?? 'PI_FINAL_PROMPT_SENTINEL_20260827';
const toolMarker = process.env.ANYSENTRY_E2E_TOOL_INTERACTION_MARKER
  ?? 'ANYSENTRY_TOOL_RESULT:';
const ragSentinel = 'PI_INTERNAL_RAG_SENTINEL_MUST_NOT_LEAK_20260827';
const adminToken = (process.env.ANYSENTRY_ADMIN_TOKEN ?? process.env.ANYSENTRY_MANAGEMENT_TOKEN ?? '').trim();
const chromeBinary = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const profile = mkdtempSync(path.join(tmpdir(), 'anysentry-interaction-chrome-'));
const outputDirectory = path.join(tmpdir(), `anysentry-agent-interaction-${process.pid}`);
mkdirSync(outputDirectory, { recursive: true });

async function api(pathname, body) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...managementAuthHeaders() },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} -> ${response.status}: ${text}`);
  const payload = JSON.parse(text);
  return payload?.data ?? payload;
}

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

const interactions = await api('/agents/interactions', {
  timeType: 'last_30d', scope: 'raw', limit: 100,
});
const target = interactions.items.find((item) => JSON.stringify(item).includes(marker));
assert.ok(target?.agentAssetId, 'real Pi interaction was not available to the browser verifier');
const agentAssetId = target.agentAssetId;
const externalToolTarget = interactions.items.find((item) => (
  item.interactionType === 'tool' && JSON.stringify(item).includes(toolMarker)
));
assert.ok(externalToolTarget?.agentAssetId, 'real external-tool interaction was not available to the browser verifier');

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
  const targetPage = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(dashboardUrl)}`, { method: 'PUT' })
    .then((response) => response.json());
  socket = new WebSocket(targetPage.webSocketDebuggerUrl);
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
  await command('Page.navigate', { url: dashboardUrl });
  await waitFor('dashboard origin', () => evaluate('location.origin'), (origin) => origin === new URL(dashboardUrl).origin);
  await evaluate(`localStorage.setItem('anysentry.adminToken', ${JSON.stringify(adminToken)}); localStorage.setItem('anysentry:locale', 'zh-CN')`);
  await viewport(1440, 1100);
  await command('Page.navigate', {
    url: `${dashboardUrl}/agents?timeType=last_30d&assetRange=all&selectedAgentAssetId=${encodeURIComponent(agentAssetId)}`,
  });
  await waitFor('Agent interaction panel', () => evaluate('document.body?.innerText ?? ""'),
    (text) => text.includes('Agent 与 LLM 交互') && text.includes('3 次模型调用'), 60_000);

  await evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3')].find((node) => node.textContent?.trim() === 'Agent 与 LLM 交互');
    const section = heading?.closest('section');
    [...(section?.querySelectorAll('button') ?? [])].find((button) => button.innerText.includes('1 指令 / 1 结果'))?.click();
  })()`);
  const detailText = await waitFor('interaction detail', () => evaluate('document.body?.innerText ?? ""'),
    (text) => text.includes('最终发送给 LLM 的请求')
      && text.includes('LLM 返回给 Agent 的内容')
      && text.includes('工具调用顺序与结果')
      && text.includes('call_bash_fixture')
      && text.includes('PI_BASH_RESULT_SENTINEL_20260827'), 30_000);
  assert(detailText.includes(marker));
  assert(!detailText.includes(ragSentinel));
  assert(detailText.includes('边界耗时'));
  await evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3')].find((node) => node.textContent?.trim() === 'Agent 与 LLM 交互');
    heading?.closest('section')?.scrollIntoView({ block: 'start' });
  })()`);
  await waitFor('model interaction panel in viewport', () => evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3')].find((node) => node.textContent?.trim() === 'Agent 与 LLM 交互');
    const rect = heading?.closest('section')?.getBoundingClientRect();
    return rect ? { top: rect.top, bottom: rect.bottom, height: innerHeight } : null;
  })()`), (rect) => rect && rect.top >= 0 && rect.top < rect.height);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assertNoOverflow('Agent interaction 1440');
  await screenshot('agent-interaction-1440.png');

  await viewport(390, 844);
  await assertNoOverflow('Agent interaction 390');
  await screenshot('agent-interaction-390.png');

  await viewport(1440, 1100);
  await command('Page.navigate', {
    url: `${dashboardUrl}/agents?timeType=last_30d&assetRange=all&selectedAgentAssetId=${encodeURIComponent(externalToolTarget.agentAssetId)}`,
  });
  await waitFor('external tool interaction panel', () => evaluate('document.body?.innerText ?? ""'),
    (text) => text.includes('Agent 与 LLM 交互')
      && text.includes('0 次模型调用')
      && text.includes('1 次外部工具调用')
      && text.includes('外部工具 · /tool/execute'), 60_000);
  await evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3')].find((node) => node.textContent?.trim() === 'Agent 与 LLM 交互');
    const section = heading?.closest('section');
    [...(section?.querySelectorAll('button') ?? [])].find((button) => button.innerText.includes('外部工具 · /tool/execute'))?.click();
  })()`);
  const toolDetailText = await waitFor('external tool detail', () => evaluate('document.body?.innerText ?? ""'),
    (text) => text.includes('Agent 发送给外部工具的指令')
      && text.includes('外部工具返回给 Agent 的结果')
      && text.includes('http.tool.execute')
      && text.includes('ANYSENTRY_TOOL_INSTRUCTION')
      && text.includes(toolMarker)
      && text.includes('边界耗时'), 30_000);
  assert(toolDetailText.includes('/tool/execute'));
  await evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3')].find((node) => node.textContent?.trim() === 'Agent 与 LLM 交互');
    heading?.closest('section')?.scrollIntoView({ block: 'start' });
  })()`);
  await waitFor('external tool panel in viewport', () => evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3')].find((node) => node.textContent?.trim() === 'Agent 与 LLM 交互');
    const rect = heading?.closest('section')?.getBoundingClientRect();
    return rect ? { top: rect.top, bottom: rect.bottom, height: innerHeight } : null;
  })()`), (rect) => rect && rect.top >= 0 && rect.top < rect.height);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assertNoOverflow('external tool interaction 1440');
  await screenshot('external-tool-interaction-1440.png');

  await viewport(390, 844);
  await assertNoOverflow('external tool interaction 390');
  await screenshot('external-tool-interaction-390.png');
  assert.deepEqual(runtimeExceptions, [], `browser runtime exceptions: ${runtimeExceptions.join('; ')}`);
  assert.deepEqual(failedRequests, [], `browser network failures: ${failedRequests.join('; ')}`);

  console.log(JSON.stringify({
    dashboardUrl,
    screenshots: outputDirectory,
    agentAssetId,
    externalToolAgentAssetId: externalToolTarget.agentAssetId,
    modelCalls: 3,
    externalToolCalls: 1,
    requestAndResponseVisible: true,
    toolInstructionAndResultVisible: true,
    ragSentinelAbsent: true,
    horizontalOverflow: false,
    runtimeExceptions: 0,
    networkFailures: 0,
  }, null, 2));
  console.log('PASS Agent interaction browser verification');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
