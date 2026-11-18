// Isolated browser, synthetic request bodies. Does not change capture permissions or stored data.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.ANYSENTRY_WEB_TEST_URL ?? 'http://127.0.0.1:5173';
const relatedMode = process.env.ANYSENTRY_TEST_RELATED_THREADS === '1';
const recordId = process.env.ANYSENTRY_TEST_RECORD_ID ?? 'd11e7897d0401de8daa0bd33';
const response = await fetch(`http://127.0.0.1:29653/security-center/local-records/${recordId}?limit=1&includeSystemEvidence=false&includeObservedLlmRequests=true&includeObservedLlmRequestContent=false`, {signal:AbortSignal.timeout(20000)});
assert.ok(response.ok);
const fixture = await response.json();
assert.ok(fixture.data.observedLlmRequests.length > 0);
const expectedBodies = fixture.data.observedLlmRequests.length;
fixture.data.events = [];
fixture.data.record.title = 'Observer content display regression';
fixture.data.observedLlmRequests = [{...fixture.data.observedLlmRequests[0], contentAvailability:'not_requested', content:undefined}];
if (relatedMode) {
  const sessionId = fixture.data.record.sessionId;
  fixture.data.events = [1, 2].flatMap(i => [
    {eventId:`turn-start-${i}`, kind:'turn_start', title:'Turn 开始', turnId:`main-turn-${i}`, timestamp:1000*i, sourceOffset:i*10},
    {eventId:`user-${i}`, kind:'user_message', title:'用户指令', content:`MAIN_USER_${i}`, turnId:`main-turn-${i}`, timestamp:1000*i+1, sourceOffset:i*10+1},
  ]);
  const template = fixture.data.observedLlmRequests[0];
  fixture.data.observedLlmRequests = [
    {interactionId:'main-request', model:'gpt-6-astra', threadId:sessionId, turnId:'main-turn-2'},
    {interactionId:'review-request', model:'codex-auto-review', threadId:'review-thread', turnId:'review-turn'},
    // A coincident Turn id is not proof that different threads share a Turn.
    {interactionId:'related-request', model:'gpt-6-astra', threadId:'other-thread', turnId:'main-turn-2'},
    {interactionId:'same-thread-review', model:'codex-auto-review', threadId:sessionId, turnId:'main-turn-1'},
    {interactionId:'unknown-thread-review', model:'codex-auto-review', threadId:'', turnId:undefined},
  ].map((row,i) => ({...template, ...row, sessionId, observedAt:2002+i}));
  fixture.data.page.hasMore = false;
}
const profile = await mkdtemp(path.join(os.tmpdir(), 'anysentry-content-browser-'));
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new','--disable-gpu','--no-first-run', '--no-default-browser-check', '--remote-debugging-port=17498', `--user-data-dir=${profile}`, 'about:blank'], {stdio:'ignore'});
let ws;
const wait = ms => new Promise(r=>setTimeout(r,ms));
try {
  let pages;
  for(let i=0;i<80;i++) {
    try { pages = await (await fetch('http://127.0.0.1:17498/json/list')).json(); if(pages.length) break; } catch {}
    await wait(100);
  }
  assert.ok(pages?.length, 'isolated Chrome started');
  ws = new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let next=0; const pending=new Map();
  ws.onmessage = e => {const m=JSON.parse(e.data); if(m.id) {const p=pending.get(m.id); pending.delete(m.id); m.error?p?.reject(new Error(m.error.message)):p?.resolve(m.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression => (await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await wait(100);}throw new Error(`Browser condition failed: ${expression}`);};
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  if (!process.env.ANYSENTRY_TEST_REAL_CONTENT) await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    const originalFetch=window.fetch.bind(window);
    const fixture=${JSON.stringify(fixture)};
    window.testBodyMode='available'; window.testBodyReads=0;
    window.fetch=async (input,options)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.pathname==='/security-center/local-records/${recordId}') {
        const data=structuredClone(fixture);
        if(url.searchParams.get('includeObservedLlmRequestContent')==='true') {
          window.testBodyReads++;
          const mode=window.testBodyMode;
          await new Promise(r=>setTimeout(r,600));
          if(mode==='fail') return new Response(JSON.stringify({code:503,message:'fixture body read failed'}),{status:503,headers:{'Content-Type':'application/json'}});
          data.data.observedLlmRequests.forEach((request,i)=>{
            request.contentAvailability=mode;
            if(mode==='available') request.content=i===0?'OBSERVER_BODY_RENDERED':'RELATED_BODY_'+i;
          });
        }
        return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
      }
      return originalFetch(input,options);
    };`});
  await send('Page.navigate',{url:`${base}/record-tracking?record=${recordId}`});
  await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('会话 & 模型请求'))`);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('会话 & 模型请求')).click()`);
  if (process.env.ANYSENTRY_TEST_REAL_CONTENT) {
    if (process.env.ANYSENTRY_TEST_REAL_RELATED) {
      // Re-read metadata: the synthetic fixture normalization above is not used by this browser.
      const real = await (await fetch(`http://127.0.0.1:29653/security-center/local-records/${recordId}?limit=250&includeSystemEvidence=false&includeObservedLlmRequests=true&includeObservedLlmRequestContent=false`, {signal:AbortSignal.timeout(20000)})).json();
      const separated = real.data.observedLlmRequests.filter(r=>r.model?.toLowerCase()==='codex-auto-review'||(r.threadId&&r.threadId!==real.data.record.sessionId));
      assert.ok(separated.length > 0);
      await until(`document.querySelectorAll('[data-related-requests] [data-evidence-source="observer_ebpf"]').length === ${separated.length}`);
      assert.equal(await evaluate(`document.querySelectorAll('[data-related-requests] [data-semantic-turn]').length`),0);
      assert.equal(await evaluate(`document.querySelectorAll('[data-semantic-turn] [data-request-scope="auto_review"], [data-semantic-turn] [data-request-scope="related_thread"]').length`),0);
      assert.equal(await evaluate(`document.querySelectorAll('[data-related-requests] button[aria-expanded="false"]').length`), separated.length);
      await evaluate(`document.querySelectorAll('[data-related-requests] button[aria-expanded="false"]').forEach(b=>b.click())`);
      const text = await evaluate(`document.querySelector('[data-related-requests]').innerText`);
      for (const r of separated) assert.ok(text.includes(r.interactionId) && (!r.threadId || text.includes(r.threadId)));
      await evaluate(`document.querySelector('[data-related-requests]').scrollIntoView({block:'start'})`);
      await writeFile(path.join(profile,'real-related-requests.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
      console.log(JSON.stringify({pass:true,realRelatedRequests:separated.length,mainTurnGroups:await evaluate(`document.querySelectorAll('[data-semantic-turn]').length`),screenshots:profile}));
    } else if (process.env.ANYSENTRY_TEST_TURN_BOUNDARIES) {
      await until(`document.querySelectorAll('[data-semantic-kind="tool_call"]').length > 0 && document.querySelectorAll('[data-semantic-turn]').length > 0`);
      assert.equal(await evaluate(`document.querySelectorAll('[data-semantic-kind="turn_start"], [data-semantic-kind="turn_complete"]').length`), 0);
      console.log(JSON.stringify({pass:true,checks:['Turn groups retained','tool calls retained','Turn start/complete cards hidden']}));
    } else {
    await until(`!document.body.innerText.includes('正在加载模型请求正文') && document.querySelectorAll('[data-evidence-source="observer_ebpf"] pre').length === ${expectedBodies}`);
    assert.equal(await evaluate(`document.body.innerText.includes('未获本机直显授权')`), false);
    assert.equal(await evaluate(`document.querySelectorAll('[data-semantic-kind="turn_start"], [data-semantic-kind="turn_complete"]').length`), 0, 'Turn boundary cards stay hidden in the semantic tab');
    console.log(JSON.stringify({pass:true,realContent:true,renderedObserverBodies:await evaluate(`document.querySelectorAll('[data-evidence-source="observer_ebpf"] pre').length`)}));
    }
    await send('Browser.close');
  } else {
  await until(`document.body.innerText.includes('正在加载模型请求正文')`);
  assert.equal(await evaluate(`document.body.innerText.includes('未获本机直显授权')`),false);
  await until(`document.body.innerText.includes('OBSERVER_BODY_RENDERED')`);
  assert.ok(await evaluate(`document.body.innerText.includes('个分组')`));
  if (relatedMode) {
    assert.equal(await evaluate(`document.querySelectorAll('[data-semantic-turn]').length`), 2);
    assert.equal(await evaluate(`document.querySelectorAll('[data-related-requests] [data-evidence-source="observer_ebpf"]').length`), 4);
    assert.equal(await evaluate(`document.querySelectorAll('[data-related-requests] [data-semantic-turn]').length`), 0);
    assert.equal(await evaluate(`document.querySelectorAll('[data-request-scope="main"]').length`), 1);
    assert.equal(await evaluate(`document.querySelectorAll('[data-request-scope="auto_review"]').length`), 3);
    assert.equal(await evaluate(`document.querySelectorAll('[data-related-requests] button[aria-expanded="false"]').length`), 4);
    assert.equal(await evaluate(`document.querySelector('[data-related-requests]').innerText.includes('RELATED_BODY_')`), false, 'related bodies default collapsed');
    await evaluate(`document.querySelector('[data-related-requests] button').focus()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await until(`document.querySelector('[data-related-requests] button').getAttribute('aria-expanded')==='true'`);
    assert.equal(await evaluate(`document.querySelector('[data-related-requests]').innerText.includes('RELATED_BODY_1')`),true);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await until(`document.querySelector('[data-related-requests] button').getAttribute('aria-expanded')==='false'`);
    assert.equal(await evaluate(`document.querySelector('[data-related-requests]').innerText.includes('RELATED_BODY_1')`),false);
    await evaluate(`document.querySelectorAll('[data-related-requests] button[aria-expanded="false"]').forEach(b=>b.click())`);
    const relatedText = await evaluate(`document.querySelector('[data-related-requests]').innerText`);
    for (const text of ['自动审核请求', '关联线程请求', 'review-thread', 'review-turn', 'other-thread', 'main-turn-2', 'Thread：未记录', 'Turn：未记录', 'RELATED_BODY_4']) assert.ok(relatedText.includes(text), text);
    assert.equal(await evaluate(`document.body.innerText.includes('Turn 分组 3')`), false);
    for (const filter of ['仅工具', '仅 AI', '全部关系']) {
      await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(filter)}).click()`);
      await wait(100);
      assert.equal(await evaluate(`Boolean(document.querySelector('[data-related-requests]'))`), filter !== '仅工具');
    }
    await evaluate(`document.querySelectorAll('[data-related-requests] button[aria-expanded="false"]').forEach(b=>b.click())`);
    await evaluate(`document.querySelector('[data-related-requests]').scrollIntoView({block:'start'})`);
    await writeFile(path.join(profile, 'related-requests.png'), Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  }
  const refresh = async mode => {
    await until(`[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='刷新').at(-1)?.disabled === false`);
    await evaluate(`window.testBodyMode=${JSON.stringify(mode)}; [...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='刷新').at(-1).click()`);
  };
  await refresh('not_authorized');
  await until(`document.body.innerText.includes('未获本机直显授权')`);
  assert.equal(await evaluate(`document.body.innerText.includes('OBSERVER_BODY_RENDERED')`),false, 'revoked content is replaced');
  if (relatedMode) assert.equal(await evaluate(`document.body.innerText.includes('RELATED_BODY_')`), false, 'revoked related content is removed');
  await refresh('fail');
  await until(`document.body.innerText.includes('正文请求失败')`);
  await evaluate(`window.testBodyMode='available'; [...document.querySelectorAll('button')].find(b=>b.textContent.includes('重试正文')).click()`);
  await until(`document.body.innerText.includes('OBSERVER_BODY_RENDERED') && !document.body.innerText.includes('正文请求失败')`);
  const reads = await evaluate('window.testBodyReads');
  if (relatedMode) {
    assert.equal(await evaluate(`document.querySelectorAll('[data-semantic-turn]').length`), 2);
    assert.equal(await evaluate(`document.querySelectorAll('[data-related-requests] pre').length`), 4);
  }
  console.log(JSON.stringify({pass:true,relatedThreads:relatedMode,checks:['delayed body rerenders','metadata is not denied','Turn scope label','manual refresh','authorization denial removes body','failure and retry',...(relatedMode?['default collapsed','Enter expands / Space collapses','review/different threads excluded from Turn numbering','same Turn collision isolated','missing IDs preserved','all requests retained','filters']:[])],bodyRequests:reads,screenshots:relatedMode?profile:undefined}));
  await send('Browser.close');
  }
} finally {
  ws?.close(); chrome.kill('SIGTERM');
}
