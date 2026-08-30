#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const apiBase = (process.env.ANYSENTRY_API_BASE
  ?? `http://127.0.0.1:${process.env.PORT ?? '29653'}/security-center`).replace(/\/$/u, '');
const dashboardUrl = (process.env.ANYSENTRY_DASHBOARD_URL
  ?? apiBase.replace(/\/security-center$/u, '')).replace(/\/$/u, '');
const marker = process.env.ANYSENTRY_CONVERSATION_MARKER ?? 'FINAL_REQUEST_SENTINEL';
const responseMarker = process.env.ANYSENTRY_CONVERSATION_RESPONSE_MARKER ?? 'VISIBLE_RESPONSE_SENTINEL';
const toolMarker = process.env.ANYSENTRY_CONVERSATION_TOOL_MARKER ?? 'TOOL_RESULT_SENTINEL';
const requestedConversationId = process.env.ANYSENTRY_CONVERSATION_ID?.trim();
const chromeBinary = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const profile = mkdtempSync(path.join(tmpdir(), 'anysentry-conversation-chrome-'));
const outputDirectory = path.join(tmpdir(), `anysentry-conversation-view-${process.pid}`);
mkdirSync(outputDirectory, { recursive: true });

async function api(pathname, body) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

let conversations = await api('/agents/conversations', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  ...(requestedConversationId ? { conversationId: requestedConversationId } : { q: marker }),
  limit: 50,
});
let conversation = conversations.items.find((item) => item.hasContent && (
  requestedConversationId
    ? item.conversationId === requestedConversationId
    : item.firstPromptPreview?.includes(marker)
));
if (!conversation) {
  const interactions = await api('/agents/interactions', {
    timeType: 'last_30d', scope: 'agent', classificationView: 'current_effective', limit: 500,
  });
  const interaction = interactions.items.find((item) => JSON.stringify(item).includes(marker));
  if (interaction?.agentAssetId) {
    conversations = await api('/agents/conversations', {
      timeType: 'last_30d',
      scope: 'agent',
      classificationView: 'current_effective',
      agentAssetId: interaction.agentAssetId,
      limit: 100,
    });
    for (const candidate of conversations.items.filter((item) => item.hasContent)) {
      const timeline = await api('/agents/conversations/timeline', {
        timeType: 'last_30d',
        scope: 'agent',
        classificationView: 'current_effective',
        agentAssetId: interaction.agentAssetId,
        conversationId: candidate.conversationId,
      });
      if (JSON.stringify(timeline).includes(marker)) {
        conversation = candidate;
        break;
      }
    }
  }
}
assert.ok(conversation?.conversationId, `conversation fixture not found: ${JSON.stringify(conversations)}`);
const scopedTimeline = await api('/agents/conversations/timeline', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  agentAssetId: conversation.agentAssetId,
  conversationId: conversation.conversationId,
});
assert.ok(scopedTimeline.items.length > 0,
  'conversationId must remain resolvable when its owning agentAssetId is supplied');
assert.ok(JSON.stringify(scopedTimeline).includes(marker),
  'scoped conversation timeline must retain the selected plaintext marker');
const scopedInteractionId = scopedTimeline.interactionIds.at(-1);
assert.ok(scopedInteractionId, 'conversation timeline must retain its Interaction references');
const scopedInteraction = await api('/agents/interactions', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  agentAssetId: conversation.agentAssetId,
  interactionId: scopedInteractionId,
  limit: 1,
});
assert.equal(scopedInteraction.items[0]?.interactionId, scopedInteractionId,
  'interactionId must remain resolvable through a reconciled Agent asset alias');
const semanticTimeline = await api('/agents/conversations/timeline-v2', {
  timeType: 'last_30d',
  scope: 'agent',
  classificationView: 'current_effective',
  agentAssetId: conversation.agentAssetId,
  conversationId: conversation.conversationId,
});
assert.ok(semanticTimeline.turns.length > 0, 'V2 timeline must expose semantic turns');
assert.deepEqual(
  [...new Set(semanticTimeline.turns.flatMap((turn) => turn.events.map((event) => event.actor)))].sort(),
  ['model', 'tool', 'user'],
  'the visible actor contract must contain only User, Model and Tool',
);

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
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeExceptions.push(message.params.exceptionDetails?.text ?? 'runtime exception');
    }
    if (message.method === 'Network.loadingFailed'
      && !message.params.canceled
      && message.params.errorText !== 'net::ERR_ABORTED') {
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
    const image = await command('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    });
    writeFileSync(path.join(outputDirectory, name), Buffer.from(image.data, 'base64'));
  };
  const assertNoOverflow = async (label) => {
    const size = await evaluate('({ width: innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth })');
    assert(size.doc <= size.width + 1, `${label} document overflow: ${JSON.stringify(size)}`);
    assert(size.body <= size.width + 1, `${label} body overflow: ${JSON.stringify(size)}`);
  };

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  await viewport(1440, 1000);
  const url = `${dashboardUrl}/conversations?timeType=last_30d&conversationId=${encodeURIComponent(conversation.conversationId)}`;
  await command('Page.navigate', { url });
  const bodyText = await waitFor('conversation timeline', () => evaluate('document.body?.innerText ?? ""'),
    (text) => text.includes('对话追踪')
      && text.includes(marker)
      && text.includes('用户')
      && text.includes('模型')
      && text.includes('工具')
      && text.includes(toolMarker), 60_000);
  assert(!bodyText.includes('management token required'));
  assert.equal(await evaluate('document.querySelectorAll("[role=option]").length > 0'), true);
  const panelSeparators = await evaluate(`[...document.querySelectorAll('[role="separator"]')]
    .map((node) => ({ label: node.getAttribute('aria-label'), display: getComputedStyle(node).display }))`);
  assert.equal(
    panelSeparators.filter((item) => [
      '调整 Agent 目录宽度',
      '调整事件检查器宽度',
    ].includes(item.label)).length,
    2,
    `resizable panel separators: ${JSON.stringify(panelSeparators)}`,
  );
  const resized = await evaluate(`(() => new Promise((resolve) => {
    const workspace = document.querySelector('#conversation-workspace > div');
    const separator = document.querySelector('[role="separator"][aria-label="调整 Agent 目录宽度"]');
    if (!workspace || !separator) { resolve(false); return; }
    const before = getComputedStyle(workspace).getPropertyValue('--conversation-left');
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    requestAnimationFrame(() => {
      const after = getComputedStyle(workspace).getPropertyValue('--conversation-left');
      resolve(before !== after);
    });
  }))()`);
  assert.equal(resized, true, 'keyboard resizing must update the left panel width');
  await assertNoOverflow('conversation 1440');
  await screenshot('conversation-tracking-1440.png');

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('模型')
        && node.textContent?.includes(${JSON.stringify(responseMarker)}))
      ?? [...document.querySelectorAll('button')]
        .find((node) => node.textContent?.includes('用户')
          && node.textContent?.includes(${JSON.stringify(marker)}));
    button?.click();
  })()`);
  await waitFor(
    'interaction inspector',
    () => evaluate('document.querySelectorAll("[role=tab]").length'),
    (count) => count === 3,
  );
  await waitFor(
    'interaction deep link',
    () => evaluate('location.search.includes("interactionId=")'),
    Boolean,
  );
  await evaluate(`(() => {
    const raw = [...document.querySelectorAll('[role=tab]')]
      .find((node) => node.textContent?.trim() === '原始');
    raw?.click();
  })()`);
  const rawText = await waitFor('raw interaction body', () => evaluate('document.body?.innerText ?? ""'),
    (text) => text.includes('最终发送给 LLM / 工具的请求')
      && text.includes('LLM / 工具返回给 Agent 的响应')
      && text.includes(marker)
      && text.includes(responseMarker));
  assert(rawText.includes(toolMarker));
  await screenshot('conversation-inspector-1440.png');

  await viewport(1024, 900);
  await assertNoOverflow('conversation 1024');
  await screenshot('conversation-inspector-1024.png');

  await viewport(390, 844);
  await assertNoOverflow('conversation inspector 390');
  await screenshot('conversation-inspector-390.png');
  await evaluate(`(() => {
    const controls = [...document.querySelectorAll('[aria-label="关闭事件检查器"]')];
    controls.at(-1)?.click();
  })()`);
  await waitFor('mobile inspector close', () => evaluate('document.querySelectorAll("[role=tab]").length'), (count) => count === 0);
  await assertNoOverflow('conversation timeline 390');
  await screenshot('conversation-timeline-390.png');

  assert.deepEqual(runtimeExceptions, [], `browser runtime exceptions: ${runtimeExceptions.join('; ')}`);
  assert.deepEqual(failedRequests, [], `browser network failures: ${failedRequests.join('; ')}`);
  console.log(JSON.stringify({
    dashboardUrl,
    screenshots: outputDirectory,
    conversationId: conversation.conversationId,
    managementTokenRequiredForRead: false,
    semanticActors: ['user', 'model', 'tool'],
    resizablePanels: true,
    desktopTimelineVisible: true,
    inspectorStructuredRawEvidence: true,
    responsiveViewports: [1440, 1024, 390],
    horizontalOverflow: false,
    runtimeExceptions: 0,
    networkFailures: 0,
  }, null, 2));
  console.log('PASS Conversation Tracking browser verification');
} finally {
  try { socket?.close(); } catch {}
  chrome.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
