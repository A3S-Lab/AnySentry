// Browser-only fixtures; no event ingestion or attribution writes.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:net';
import {buildLocalToolEvidence} from '../apps/api/dist/security-monitoring/local-tool-evidence.js';

const base=process.env.ANYSENTRY_WEB_TEST_URL??'http://127.0.0.1:5173';
const realMode=process.env.ANYSENTRY_TEST_REAL_LINK==='1';
const recordId=process.env.ANYSENTRY_TEST_RECORD_ID??'d12e75b6dc796cf1c8b24724';
const selectedEvidence=process.env.ANYSENTRY_TEST_CALL_ID
  ? `[...document.querySelectorAll('[data-tool-system-evidence]')].find(e=>e.textContent.includes(${JSON.stringify(process.env.ANYSENTRY_TEST_CALL_ID)}))`
  : `document.querySelector('[data-tool-system-evidence]')`;
const fixture=await(await fetch(`http://127.0.0.1:29653/security-center/local-records/${recordId}?limit=50&includeSystemEvidence=false&includeObservedLlmRequests=true&includeObservedLlmRequestContent=false`,{signal:AbortSignal.timeout(25000)})).json();
assert.ok(fixture.data?.record);
const sid=fixture.data.record.sessionId;
const call=(i,content)=>({eventId:`call-${i}`,kind:'tool_call',title:'调用 exec',toolName:'exec',callId:`call-id-${i}`,turnId:`turn-${i===3?2:1}`,timestamp:1000*i,sourceOffset:10*i,content});
const calls=[call(1,'{"cmd":"/usr/bin/true"}'),call(2,'text(await tools.exec_command({cmd:"/usr/bin/printf marker"}));'),call(3,'tools.exec_command({cmd:dynamicCommand})')];
fixture.data.events=[{eventId:'user',kind:'user_message',title:'用户指令',content:'LINK_FIXTURE_USER',turnId:'turn-1',timestamp:999,sourceOffset:1},...calls.flatMap(c=>[c,{...c,eventId:`result-${c.eventId}`,kind:'tool_result',title:'exec结果',timestamp:c.timestamp+500,sourceOffset:c.sourceOffset+1,content:'LINK_RESULT'}])];
fixture.data.page.hasMore=false;
fixture.data.observedLlmRequests=[{...fixture.data.observedLlmRequests[0],interactionId:'main-request',model:'gpt-6-astra',sessionId:sid,threadId:sid,turnId:'turn-1',observedAt:999,contentAvailability:'not_requested'}, {...fixture.data.observedLlmRequests[0],interactionId:'review-request',model:'codex-auto-review',sessionId:sid,threadId:'review-thread',turnId:'review-turn',observedAt:3100,contentAvailability:'not_requested'}];
const sys=(id,at,command)=>({eventId:id,relationId:`rel-${id}`,relation:'LINEAGE',at,command,eventKind:'ToolExec',eventCategory:'process',subject:command,processInstanceKey:`pri-${id}`,pid:123,ppid:120,verdict:'allow',tier:'Rules',severity:'info',riskScore:0,confidence:0.9});
const systems=[{...sys('confirmed',1200,'/usr/bin/true'),toolCallBinding:{method:'authenticated_agent_adapter',toolCallId:'call-id-1',invocationId:'inv-1'}},sys('candidate',2200,'/usr/bin/printf marker'),sys('unassigned',3200,'other command')];
const evidence={schemaVersion:'anysentry.local-session-system-evidence.v1',conversationId:'conv-fixture',binding:{nativeSessionId:sid,matchedPid:120,bindingRevision:1},counts:{direct:0,lineage:3,ambiguous:0,conflict:0,unattributed:0},page:{requestedLimit:250,totalRelations:3,loadedRelations:3,returnedEvents:3,processFamilyTruncated:true,hasMore:true,unavailableEvents:0},events:systems,lineage:[],exceptions:[],completeness:'partial',persistence:'not_checked'};
const projection=buildLocalToolEvidence(sid,fixture.data.events,evidence);
const profile=await mkdtemp(path.join(os.tmpdir(),'anysentry-link-browser-'));
const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));
const debugPort=portServer.address().port;await new Promise(r=>portServer.close(r));
const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
let systemReads=0;
const inFlightSystemReads=new Set();
try {
  let pages;
  for(let i=0;i<80;i++){try{pages=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();if(pages.length)break;}catch{}await wait(100);}
  assert.ok(pages?.length);
  ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let next=0;const pending=new Map();
  ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.method==='Network.requestWillBeSent'&&m.params.request.url.includes('includeSystemEvidence=true')){
      systemReads++;inFlightSystemReads.add(m.params.requestId);
    }
    if(m.method==='Network.loadingFinished'||m.method==='Network.loadingFailed')inFlightSystemReads.delete(m.params.requestId);
    if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(new Error(m.error.message)):p?.resolve(m.result);}
  };
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  const until=async expression=>{for(let i=0;i<400;i++){if(await evaluate(expression))return;await wait(100);}throw new Error(`Browser timeout: ${expression}`);};
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  if(!realMode) await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    const originalFetch=window.fetch.bind(window),fixture=${JSON.stringify(fixture)},evidence=${JSON.stringify(evidence)},projection=${JSON.stringify(projection)};
    window.systemReads=0;window.systemMode='ok';window.contentMode='available';
    window.fetch=async(input,options)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.pathname==='/security-center/local-records/${recordId}'){
        const value=structuredClone(fixture);
        if(url.searchParams.get('includeSystemEvidence')==='true'){
          window.systemReads++;await new Promise(r=>setTimeout(r,700));
          if(window.systemMode==='fail')return new Response(JSON.stringify({code:503,message:'fixture evidence unavailable'}),{status:503,headers:{'Content-Type':'application/json'}});
          value.data.systemEvidence=structuredClone(evidence);
          value.data.toolEvidence=structuredClone(projection);
          if(Number(url.searchParams.get('evidenceLimit'))>250){value.data.systemEvidence.events.push({...evidence.events[2],eventId:'page-2',relationId:'rel-page-2'});value.data.systemEvidence.page={...evidence.page,requestedLimit:500,totalRelations:4,loadedRelations:4,returnedEvents:4,processFamilyTruncated:false,hasMore:false};}
        }
        if(url.searchParams.get('includeObservedLlmRequestContent')==='true'){
          await new Promise(r=>setTimeout(r,300));
          for(const request of value.data.observedLlmRequests){request.contentAvailability=window.contentMode;request.content=window.contentMode==='available'?'LINK_MODEL_BODY':undefined;}
        }
        return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
      }return originalFetch(input,options);
    };`});
  await send('Page.navigate',{url:`${base}/record-tracking?record=${recordId}`});
  await until(`Boolean(document.querySelector('[data-detail-tab="link_awareness"]'))`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-detail-tab]')].map(b=>b.dataset.detailTab).slice(0,4)`),['conversation','trace','link_awareness','system_evidence']);
  await evaluate(`document.querySelector('[data-detail-tab="semantic_tree"]').click()`);
  await until(`document.querySelectorAll('[data-semantic-kind="tool_call"]').length>0`);
  const toolCount=await evaluate(`document.querySelectorAll('[data-semantic-kind="tool_call"]').length`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-tool-system-evidence]').length`),0,'original tab unchanged');
  if(!realMode)assert.equal(await evaluate('window.systemReads'),0,'evidence lazy loaded');
  await evaluate(`document.querySelector('[data-detail-tab="link_awareness"]').click()`);
  await until(`document.querySelectorAll('[data-tool-system-evidence]').length===${toolCount}`);
  if(realMode && (process.env.ANYSENTRY_TEST_CANDIDATE_COUNTS || process.env.ANYSENTRY_TEST_CALL_ID)){
    for(let i=0;i<20;i++){
      if(process.env.ANYSENTRY_TEST_CALL_ID && await evaluate(`Boolean((${selectedEvidence})?.textContent.includes(${JSON.stringify(process.env.ANYSENTRY_TEST_EVENT_ID)}))`))break;
      const more=await evaluate(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.includes('再加载 250 条系统关系')))`);
      if(!more)break;
      await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('再加载 250 条系统关系')).click()`);
      await until(`![...document.querySelectorAll('button')].some(b=>b.textContent.includes('再加载 250 条系统关系') && b.disabled) && !document.querySelector('[aria-label="链路感知状态"] [role="status"]')`);
    }
    if(process.env.ANYSENTRY_TEST_CANDIDATE_COUNTS){
      const expected=JSON.parse(process.env.ANYSENTRY_TEST_CANDIDATE_COUNTS);
      const actual=await evaluate(`[...document.querySelectorAll('[data-tool-system-evidence] > summary')].map(e=>Number(e.innerText.match(/候选 (\\d+) 条/)?.[1]??0))`);
      assert.deepEqual(actual,expected,'live per-call candidates match captured execution sample');
    }
    if(process.env.ANYSENTRY_TEST_CALL_ID){
      const id=JSON.stringify(process.env.ANYSENTRY_TEST_CALL_ID),event=JSON.stringify(process.env.ANYSENTRY_TEST_EVENT_ID);
      await until(`[...document.querySelectorAll('[data-tool-system-evidence]')].some(e=>e.textContent.includes(${id})&&e.textContent.includes(${event}))`);
      await evaluate(`[...document.querySelectorAll('[data-tool-system-evidence]')].find(e=>e.textContent.includes(${id})).open=true`);
    }
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-tool-system-evidence] summary')].filter(e=>e.innerText.includes('已确认')).length`), 0, 'command candidates never become authenticated confirmations');
    await evaluate(`(${selectedEvidence}).open=true`);
    assert.ok(await evaluate(`(${selectedEvidence}).innerText.includes('候选不代表可信调用绑定')`));
  }
  if(!realMode){
    assert.ok(await evaluate(`document.querySelector('[data-tool-system-evidence="call-1"] summary').innerText.includes('已确认')`));
    assert.ok(await evaluate(`document.querySelector('[data-tool-system-evidence="call-2"] summary').innerText.includes('候选')`));
    assert.ok(await evaluate(`document.querySelector('[data-unassigned-system-evidence] summary').innerText.includes('2 条')`));
    assert.equal(await evaluate(`document.querySelectorAll('[data-semantic-turn]').length`),2);
    assert.equal(await evaluate(`document.querySelectorAll('[data-related-requests] [data-tool-system-evidence]').length`),0,'review thread never owns main tools');
    assert.equal(await evaluate(`document.querySelectorAll('[data-tool-system-evidence][open]').length`),0,'default collapsed');
    await evaluate(`document.querySelector('[data-tool-system-evidence="call-1"] summary').focus()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await until(`document.querySelector('[data-tool-system-evidence="call-1"]').open`);
    assert.ok(await evaluate(`document.querySelector('[data-tool-system-evidence="call-1"]').innerText.includes('已确认')`));
    await evaluate(`document.querySelector('[data-tool-system-evidence="call-2"] summary').click()`);
    assert.ok(await evaluate(`document.querySelector('[data-tool-system-evidence="call-2"]').innerText.includes('候选不代表可信调用绑定')`));
    assert.ok(await evaluate(`document.querySelector('[data-tool-system-evidence="call-3"] summary').innerText.includes('证据未查全 · 暂无调用明细')`));
    assert.ok(await evaluate(`document.querySelector('[data-tool-system-evidence="call-1"] a').getAttribute('href').includes('eventId=confirmed')`));
    for(const filter of ['仅 AI','仅工具','全部关系']){
      await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(filter)}).click()`);
      await wait(100);
      assert.equal(await evaluate(`document.querySelectorAll('[data-tool-system-evidence]').length`),filter==='仅 AI'?0:3);
    }
  }
  await evaluate(`(${selectedEvidence}).querySelector('summary').scrollIntoView({block:'center'})`);
  await writeFile(path.join(profile,'link-awareness.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
  await evaluate(`(${selectedEvidence}).querySelector('summary').scrollIntoView({block:'center'})`);
  await writeFile(path.join(profile,'link-awareness-mobile.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  await evaluate(`document.querySelector('[data-detail-tab="semantic_tree"]').click()`);
  await until(`document.querySelectorAll('[data-tool-system-evidence]').length===0`);
  if(!realMode){
    await evaluate(`document.querySelector('[data-detail-tab="system_evidence"]').click()`);
    await until(`document.body.innerText.includes('持久化状态未核验')`);
    assert.equal(await evaluate(`document.body.innerText.includes('持久化降级')`),false,'read-only evidence does not imply persistence failure');
  }
  if(process.env.ANYSENTRY_TEST_STARTUP_COUNT){
    const expected=Number(process.env.ANYSENTRY_TEST_STARTUP_COUNT);
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.querySelector('[data-detail-tab="system_evidence"]').click()`);
    await until(`Boolean(document.querySelector('[data-startup-context]'))`);
    assert.ok(await evaluate(`document.querySelector('[data-startup-context] summary').innerText.includes('身份切换前 ${expected} 条事件')`));
    assert.equal(await evaluate(`document.body.innerText.includes('需要复核的归属结果')`),false,'startup history must not be a runtime conflict warning');
    await evaluate(`document.querySelector('[data-startup-context] summary').focus()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await until(`document.querySelector('[data-startup-context]').open`);
    assert.equal(await evaluate(`document.querySelector('[data-startup-context]').innerText.split('此前身份：').length-1`),expected);
    await evaluate(`document.querySelector('[data-startup-context]').scrollIntoView({block:'center'})`);
    await writeFile(path.join(profile,'startup-context.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
    await send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.querySelector('[data-startup-context]').scrollIntoView({block:'center'})`);
    assert.equal(await evaluate(`document.querySelector('[data-startup-context]').scrollWidth > document.querySelector('[data-startup-context]').clientWidth`),false,'startup IDs must wrap on mobile');
    await writeFile(path.join(profile,'startup-context-mobile.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  }
  if(process.env.ANYSENTRY_TEST_POLLING==='1'){
    await evaluate(`document.querySelector('[data-detail-tab="system_evidence"]').click()`);
    await wait(1500);
    // Polling is scheduled after the current request settles, not from the tab click. A large
    // real evidence page can take longer than the polling interval itself.
    for(let i=0;i<1000&&inFlightSystemReads.size;i++)await wait(100);
    assert.equal(inFlightSystemReads.size,0,'current evidence read must finish before measuring the next poll');
    const before=realMode?systemReads:await evaluate('window.systemReads');
    for(let i=0;i<220;i++){if((realMode?systemReads:await evaluate('window.systemReads'))>before)break;await wait(100);}
    assert.ok((realMode?systemReads:await evaluate('window.systemReads'))>before,'active evidence tab must refresh without a user click');
  }
  console.log(JSON.stringify({pass:true,realMode,toolCount,counts,checks:['adjacent tab','original tab unchanged','per-call disclosures','related thread isolation',...(!realMode?['trusted vs candidate','keyboard','pagination','error retry','filters']:[])],screenshots:profile}));
  await send('Browser.close');
} finally {ws?.close();chrome.kill('SIGTERM');}
