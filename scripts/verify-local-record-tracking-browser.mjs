#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dashboardUrl = (
  process.env.ANYSENTRY_DASHBOARD_URL ?? 'http://127.0.0.1:29653'
).replace(/\/$/u, '');
const requestedRecordId = process.env.ANYSENTRY_RECORD_ID?.trim() ?? '';
const chromeBinary = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const profile = mkdtempSync(path.join(tmpdir(), 'anysentry-local-records-chrome-'));
const outputDirectory = path.join(
  tmpdir(),
  `anysentry-local-records-browser-${process.pid}`,
);
mkdirSync(outputDirectory, { recursive: true });

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(label, read, accept, timeoutMs = 60_000) {
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
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const pending = new Map();
let commandId = 0;
const runtimeExceptions = [];
const failedRequests = [];
const requestedUrls = [];

try {
  await waitFor(
    'Chrome DevTools endpoint',
    async () =>
      fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok),
    Boolean,
  );
  const target = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${dashboardUrl}/record-tracking`)}`,
    { method: 'PUT' },
  ).then((response) => response.json());
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
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeExceptions.push(
        message.params.exceptionDetails?.text ?? 'runtime exception',
      );
    }
    if (
      message.method === 'Network.loadingFailed'
      && !message.params.canceled
      && message.params.errorText !== 'net::ERR_ABORTED'
    ) {
      failedRequests.push(message.params.errorText);
    }
    if (message.method === 'Network.requestWillBeSent') {
      requestedUrls.push(message.params.request?.url ?? '');
    }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed');
    }
    return result.result?.value;
  };
  const viewport = (width, height) =>
    command('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
  const screenshot = async (name) => {
    const image = await command('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    writeFileSync(path.join(outputDirectory, name), Buffer.from(image.data, 'base64'));
  };
  const assertNoOverflow = async (label) => {
    const size = await evaluate(`({
      width: innerWidth,
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth
    })`);
    assert(size.doc <= size.width + 1, `${label} document overflow: ${JSON.stringify(size)}`);
    assert(size.body <= size.width + 1, `${label} body overflow: ${JSON.stringify(size)}`);
  };
  const clickButton = async (label) => {
    const clicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => node.innerText.trim().includes(${JSON.stringify(label)}));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true, `button not found: ${label}`);
  };

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  await viewport(1440, 900);
  await command('Page.navigate', { url: `${dashboardUrl}/record-tracking` });
  const overviewReady = await waitFor(
    'Record Tracking overview',
    () => evaluate(`({
      ready: document.readyState,
      text: document.body?.innerText ?? '',
      search: location.search,
      overview: Boolean(document.querySelector('[data-record-overview]')),
      records: document.querySelectorAll(
        '[data-record-overview] button[aria-label^="打开 Codex 会话"]'
      ).length
    })`),
    (state) =>
      state?.ready === 'complete'
      && state.text.includes('记录追踪')
      && state.text.includes('本地只读')
      && state.text.includes('本机 Agent 会话全景')
      && state.text.includes('进程状态')
      && state.text.includes('记录状态')
      && state.text.includes('会话首条指令')
      && state.text.includes('Sentry3.0')
      && state.overview
      && state.records > 0
      && !state.search.includes('record='),
  );
  assert(overviewReady.text.includes('eBPF 待关联'));
  assert(overviewReady.text.includes('标题固定为会话第一条有效用户指令'));
  assert(overviewReady.text.includes('进程状态来自 Session FD 与 PID 生命周期'));
  assert(overviewReady.text.includes('正在写入'));
  assert(overviewReady.text.includes('点击记录进入详情'));
  const overviewTheme = await evaluate(`(() => {
    const overview = document.querySelector('[data-record-overview]');
    const page = overview?.parentElement;
    const surface = overview?.firstElementChild;
    return {
      pageBackground: page ? getComputedStyle(page).backgroundColor : '',
      pageForeground: page ? getComputedStyle(page).color : '',
      surfaceBackground: surface ? getComputedStyle(surface).backgroundColor : ''
    };
  })()`);
  assert.equal(overviewTheme.pageBackground, 'rgb(248, 250, 252)');
  assert.equal(overviewTheme.pageForeground, 'rgb(15, 23, 42)');
  assert.equal(overviewTheme.surfaceBackground, 'rgb(255, 255, 255)');
  assert.equal(
    await evaluate(`Boolean([...document.querySelectorAll('a')]
      .find((link) => link.getAttribute('href') === '/record-tracking'
        && link.innerText.includes('记录追踪')))`),
    true,
    'Record Tracking sidebar entry is missing',
  );
  await assertNoOverflow('Record Tracking overview 1440');
  await screenshot('record-tracking-overview-1440.png');

  const detailOpenStartedAt = Date.now();
  if (requestedRecordId) {
    assert.match(requestedRecordId, /^[a-f0-9]{24}$/u, 'invalid ANYSENTRY_RECORD_ID');
    await command('Page.navigate', {
      url: `${dashboardUrl}/record-tracking?record=${encodeURIComponent(requestedRecordId)}`,
    });
  } else {
    const automaticRecordId = await evaluate(`fetch('/security-center/local-records?limit=300')
      .then((response) => response.json())
      .then((payload) => {
        const items = payload?.data?.items ?? [];
        const complete = (item) =>
          item.adapter === 'codex'
          && Number(item.userMessageCount ?? 0) > 0
          && Number(item.assistantMessageCount ?? 0) > 0
          && Number(item.toolCallCount ?? 0) > 0;
        return (
          items.find((item) => complete(item) && Number(item.fileBytes ?? 0) <= 50_000_000)
          ?? items.find(complete)
          ?? items.find((item) => item.adapter === 'codex')
        )?.recordId ?? '';
      })`);
    assert.match(
      automaticRecordId,
      /^[a-f0-9]{24}$/u,
      'overview did not expose a usable Codex record',
    );
    await command('Page.navigate', {
      url: `${dashboardUrl}/record-tracking?record=${encodeURIComponent(automaticRecordId)}`,
    });
  }
  const detailReady = await waitFor(
    'Record Tracking detail',
    () => evaluate(`({
      ready: document.readyState,
      text: document.body?.innerText ?? '',
      search: location.search,
      detail: Boolean(document.querySelector('[data-record-detail]'))
    })`),
    (state) =>
      state?.ready === 'complete'
      && state.text.includes('用户指令')
      && state.text.includes('Agent 回复')
      && state.text.includes('返回记录全景')
      && state.search.includes('record=')
      && state.detail,
  );
  const detailReadyMs = Date.now() - detailOpenStartedAt;
  assert(
    detailReadyMs < 5_000,
    `conversation detail should not wait for system attribution: ${detailReadyMs}ms`,
  );
  const initialDetailRequests = requestedUrls.filter((url) =>
    url.includes('/security-center/local-records/')
    && !url.includes('/security-center/local-records/status'));
  assert(
    initialDetailRequests.some((url) => url.includes('includeSystemEvidence=false')),
    'conversation detail did not request the lightweight endpoint mode',
  );
  assert.equal(
    initialDetailRequests.some((url) => url.includes('includeSystemEvidence=true')),
    false,
    'system evidence was fetched before its tab was opened',
  );
  assert.equal(
    await evaluate(`getComputedStyle(
      document.querySelector('[data-record-detail]')
    ).backgroundColor`),
    'rgb(248, 250, 252)',
  );
  const selectedRecord = new URLSearchParams(detailReady.search).get('record');
  assert(selectedRecord);
  await evaluate('window.__recordTrackingVerifierBeforeReload = true');
  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    'Record Tracking direct detail reload',
    () => evaluate(`({
      reloaded: window.__recordTrackingVerifierBeforeReload !== true,
      detail: Boolean(document.querySelector('[data-record-detail]')),
      selected: new URLSearchParams(location.search).get('record'),
      text: document.body?.innerText ?? '',
      semanticTab: [...document.querySelectorAll('button')].some(
        (button) => button.innerText.includes('进程树 & AI 提示')
      )
    })`),
    (state) =>
      state?.reloaded
      && state.detail
      && state.selected === selectedRecord
      && state.text.includes('用户指令')
      && state.semanticTab,
  );
  const conversationState = await waitFor(
    'AgentSight-style conversation record',
    () => evaluate(`(() => {
      const transcript = document.querySelector('[data-conversation-transcript]');
      const userRow = document.querySelector('[data-conversation-role="user"]');
      const assistantRow = document.querySelector('[data-conversation-role="assistant"]');
      const userBubble = userRow?.querySelector('[data-conversation-bubble]');
      const assistantBubble = assistantRow?.querySelector('[data-conversation-bubble]');
      const transcriptRect = transcript?.getBoundingClientRect();
      const userRect = userBubble?.getBoundingClientRect();
      const assistantRect = assistantBubble?.getBoundingClientRect();
      return {
        transcript: Boolean(transcript),
        users: document.querySelectorAll('[data-conversation-role="user"]').length,
        assistants: document.querySelectorAll('[data-conversation-role="assistant"]').length,
        userBackground: userBubble ? getComputedStyle(userBubble).backgroundColor : '',
        userForeground: userBubble ? getComputedStyle(userBubble).color : '',
        assistantBackground: assistantBubble ? getComputedStyle(assistantBubble).backgroundColor : '',
        assistantForeground: assistantBubble ? getComputedStyle(assistantBubble).color : '',
        userRightGap: transcriptRect && userRect ? transcriptRect.right - userRect.right : 999,
        assistantLeftGap: transcriptRect && assistantRect ? assistantRect.left - transcriptRect.left : 999,
        directional: Boolean(userRect && assistantRect && userRect.left > assistantRect.left),
        tabLabels: [...document.querySelectorAll('[data-detail-tab]')]
          .map((button) => button.textContent?.trim() ?? '')
      };
    })()`),
    (state) =>
      state?.transcript
      && state.users > 0
      && state.assistants > 0
      && state.directional,
  );
  assert.deepEqual(conversationState.tabLabels.slice(0, 4), ['对话记录', 'Trace', '链路感知', '内核事件']);
  assert.equal(conversationState.userBackground, 'rgb(2, 6, 23)');
  assert.equal(conversationState.userForeground, 'rgb(255, 255, 255)');
  assert.equal(conversationState.assistantBackground, 'rgb(241, 245, 249)');
  assert.equal(conversationState.assistantForeground, 'rgb(15, 23, 42)');
  assert(conversationState.userRightGap <= 24);
  assert(conversationState.assistantLeftGap <= 24);
  await assertNoOverflow('Record Tracking detail 1440');
  await screenshot('record-tracking-conversation-1440.png');

  await clickButton('对话时间线');
  await waitFor(
    'Record Tracking semantic timeline',
    () => evaluate(`document.querySelectorAll('[data-timeline-event]').length`),
    (count) => Number(count) > 0,
  );
  await screenshot('record-tracking-timeline-1440.png');

  await clickButton('进程树 & AI 提示');
  const treeState = await waitFor(
    'Semantic process tree',
    () => evaluate(`({
      text: document.body.innerText,
      observerPrompts: document.querySelectorAll('[data-semantic-kind="observer_ai_prompt"]').length,
      sessionPrompts: document.querySelectorAll('[data-semantic-kind="user_message"][data-evidence-source="local_session"]').length,
      responses: document.querySelectorAll('[data-semantic-kind="assistant_message"]').length,
      tools: document.querySelectorAll('[data-semantic-kind="tool_call"]').length,
      evidence: document.querySelector('[data-observer-evidence]')?.getAttribute('data-observer-evidence')
    })`),
    (state) =>
      state?.text.includes('全部关系')
      && state.text.includes('进程状态')
      && ['observed', 'not_observed', 'unavailable'].includes(state.evidence)
      && state.sessionPrompts + state.responses > 0
      && state.tools > 0,
  );
  const treeText = treeState.text;
  assert.match(treeText, /PID \d+/u);
  assert(treeText.includes('Session FD'));
  assert(treeText.includes('声明执行'));
  if (treeState.evidence === 'observed') {
    assert(treeState.observerPrompts > 0);
    assert(treeText.includes('AnySentry Observer · eBPF/Rustls'));
  } else {
    assert.equal(treeState.observerPrompts, 0);
    assert(
      treeText.includes('Observer 未观测')
      || treeText.includes('Observer 证据不可用'),
    );
  }
  await screenshot('record-tracking-semantic-tree-1440.png');

  await clickButton('系统证据');
  const systemEvidenceState = await waitFor(
    'Session system evidence',
    () => evaluate(`({
      text: document.body.innerText,
      panel: Boolean(document.querySelector('[data-system-evidence]'))
    })`),
    (state) =>
      state?.panel
      || state?.text.includes('尚未建立系统证据归属'),
  );
  if (systemEvidenceState.panel) {
    assert(systemEvidenceState.text.includes('Session 系统证据树'));
    assert(systemEvidenceState.text.includes('不代表已归因到具体 Turn、Tool Call 或用户指令'));
    assert(systemEvidenceState.text.includes('确定证据'));
    assert(systemEvidenceState.text.includes('已回查最新'));
    const beforeLoad = await evaluate(`(() => {
      const panel = document.querySelector('[data-system-evidence-events]');
      const button = [...document.querySelectorAll('button')].find(
        (item) => item.innerText.includes('再加载') && item.innerText.includes('条关系')
      );
      return {
        events: Number(panel?.getAttribute('data-system-evidence-events') ?? 0),
        relations: Number(panel?.getAttribute('data-system-evidence-loaded-relations') ?? 0),
        canLoadMore: Boolean(button)
      };
    })()`);
    if (beforeLoad.canLoadMore) {
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(
          (item) => item.innerText.includes('再加载') && item.innerText.includes('条关系')
        );
        button?.click();
      })()`);
      const afterLoad = await waitFor(
        'progressive system evidence load',
        () => evaluate(`(() => {
          const panel = document.querySelector('[data-system-evidence-events]');
          return {
            events: Number(panel?.getAttribute('data-system-evidence-events') ?? 0),
            relations: Number(panel?.getAttribute('data-system-evidence-loaded-relations') ?? 0)
          };
        })()`),
        (state) => state?.relations > beforeLoad.relations,
        120_000,
      );
      assert(afterLoad.events >= beforeLoad.events);
    }
  }
  assert(
    requestedUrls.some((url) =>
      url.includes('/security-center/local-records/')
      && url.includes('includeSystemEvidence=true')),
    'opening System Evidence did not start its independent request',
  );
  await assertNoOverflow('Record Tracking system evidence 1440');
  await screenshot('record-tracking-system-evidence-1440.png');

  await clickButton('进程树 & AI 提示');
  await waitFor(
    'Semantic process tree restored after system evidence',
    () => evaluate('document.body.innerText'),
    (text) => text.includes('全部关系') && text.includes('进程状态'),
  );
  await clickButton('仅 AI');
  const aiFilterState = await waitFor(
    'Semantic tree AI filter',
    () => evaluate(`({
      prompts: document.querySelectorAll('[data-semantic-kind="user_message"], [data-semantic-kind="observer_ai_prompt"]').length,
      responses: document.querySelectorAll('[data-semantic-kind="assistant_message"]').length,
      tools: document.querySelectorAll('[data-semantic-kind="tool_call"], [data-semantic-kind="tool_result"]').length,
      pressed: [...document.querySelectorAll('button')].some(
        (button) => button.innerText.trim() === '仅 AI' && button.getAttribute('aria-pressed') === 'true'
      )
    })`),
    (state) => state?.pressed && state.prompts + state.responses > 0 && state.tools === 0,
  );
  assert(aiFilterState.prompts + aiFilterState.responses > 0);
  await clickButton('全部关系');
  const turnCollapseClicked = await evaluate(`(() => {
    const button = document.querySelector('[data-semantic-turn]');
    if (!button || button.getAttribute('aria-expanded') !== 'true') return false;
    button.click();
    return true;
  })()`);
  assert.equal(turnCollapseClicked, true, 'semantic Turn node was not expandable');
  await waitFor(
    'Semantic Turn collapse',
    () => evaluate(`document.querySelector('[data-semantic-turn]')?.getAttribute('aria-expanded')`),
    (value) => value === 'false',
  );

  await clickButton('工具与执行');
  const toolsText = await waitFor(
    'Tool timeline',
    () => evaluate('document.body.innerText'),
    (text) =>
      text.includes('调用 ')
      && text.includes('结果'),
  );
  await screenshot('record-tracking-tools-1440.png');

  await clickButton('指标与来源');
  const metricsText = await waitFor(
    'Record metrics',
    () => evaluate('document.body.innerText'),
    (text) =>
      text.includes('Token 用量')
      && text.includes('数据与来源')
      && text.includes('进程状态')
      && text.includes('无 CPU/RSS'),
  );
  assert(metricsText.includes('源文件保持只读'));
  assert(metricsText.includes('PID '));
  await screenshot('record-tracking-metrics-1440.png');

  await new Promise((resolve) => setTimeout(resolve, 16_000));
  assert.equal(
    await evaluate(`new URLSearchParams(location.search).get('record')`),
    selectedRecord,
    'polling changed the selected local record',
  );

  await clickButton('进程树 & AI 提示');
  await waitFor(
    'Semantic process tree restored',
    () => evaluate('document.body.innerText'),
    (text) => text.includes('全部关系') && text.includes('进程状态'),
  );

  const history = await command('Page.getNavigationHistory');
  assert(history.currentIndex > 0, 'browser history does not contain the overview');
  await command('Page.navigateToHistoryEntry', {
    entryId: history.entries[history.currentIndex - 1].id,
  });
  await waitFor(
    'Record Tracking browser back to overview',
    () => evaluate(`({
      overview: Boolean(document.querySelector('[data-record-overview]')),
      selected: new URLSearchParams(location.search).get('record'),
      text: document.body?.innerText ?? '',
      records: document.querySelectorAll(
        '[data-record-overview] button[aria-label^="打开 Codex 会话"]'
      ).length
    })`),
    (state) =>
      state?.overview
      && state.selected === null
      && state.text.includes('本机 Agent 会话全景')
      && state.records > 0,
  );

  await viewport(1024, 900);
  await assertNoOverflow('Record Tracking overview 1024');
  await screenshot('record-tracking-overview-1024.png');
  await viewport(390, 844);
  await assertNoOverflow('Record Tracking overview 390');
  await screenshot('record-tracking-overview-390.png');

  const openedMobileRecord = await evaluate(`(() => {
    const button = document.querySelector(
      '[data-record-overview] button[aria-label^="打开 Codex 会话"]'
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(openedMobileRecord, true, 'mobile overview record was not clickable');
  await waitFor(
    'Record Tracking mobile detail',
    () => evaluate(`({
      detail: Boolean(document.querySelector('[data-record-detail]')),
      text: document.body?.innerText ?? ''
    })`),
    (state) =>
      state?.detail
      && state.text.includes('返回记录全景')
      && state.text.includes('对话记录')
      && state.text.includes('对话时间线'),
  );
  await assertNoOverflow('Record Tracking detail 390');
  await screenshot('record-tracking-detail-390.png');
  await clickButton('返回记录全景');
  await waitFor(
    'Record Tracking return button',
    () => evaluate(`({
      overview: Boolean(document.querySelector('[data-record-overview]')),
      selected: new URLSearchParams(location.search).get('record')
    })`),
    (state) => state?.overview && state.selected === null,
  );

  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  assert.equal(
    await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`),
    true,
  );
  assert.deepEqual(
    runtimeExceptions,
    [],
    `browser runtime exceptions: ${runtimeExceptions.join('; ')}`,
  );
  assert.deepEqual(
    failedRequests,
    [],
    `browser network failures: ${failedRequests.join('; ')}`,
  );
  console.log(JSON.stringify({
    ok: true,
    dashboardUrl,
    selectedRecord,
    screenshots: outputDirectory,
    views: ['overview', 'conversation', 'timeline', 'semantic_tree', 'system_evidence', 'tools', 'metrics'],
    viewports: ['1440x900', '1024x900', '390x844'],
    navigation: {
      overviewFirst: true,
      detailDeepLinkReload: true,
      browserBack: true,
      returnButton: true,
    },
    theme: {
      pageBackground: overviewTheme.pageBackground,
      surfaceBackground: overviewTheme.surfaceBackground,
      lightWorkspace: true,
    },
    selectionStableAcrossPolling: true,
    conversationDetailReadyMs: detailReadyMs,
    systemEvidenceDeferredUntilTab: true,
    horizontalOverflow: false,
    runtimeExceptions: 0,
    networkFailures: 0,
  }, null, 2));
} finally {
  try {
    socket?.close();
  } catch {}
  const waitForChromeExit = async (timeoutMs) => {
    if (chrome.exitCode !== null) return;
    await Promise.race([
      new Promise((resolve) => chrome.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  };
  chrome.kill('SIGTERM');
  await waitForChromeExit(2_000);
  if (chrome.exitCode === null) {
    chrome.kill('SIGKILL');
    await waitForChromeExit(2_000);
  }
  // Chrome can finish a final cache rename just after its process exit is observed. Retry the
  // disposable profile cleanup so that race cannot mask an otherwise successful browser run.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
