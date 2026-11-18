// Regression: a fresh-cache refresh must not stop native transcript polling. Uses read-only real API requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';

const base=process.env.ANYSENTRY_WEB_TEST_URL??'http://127.0.0.1:29654';
const recordId=process.env.ANYSENTRY_RECORD_TEST_ID??'d12e75b6dc796cf1c8b24724';
const profile=await mkdtemp(path.join(os.tmpdir(),'anysentry-trace-browser-'));
const tcp=createServer();await new Promise(r=>tcp.listen(0,'127.0.0.1',r));
const port=tcp.address().port;await new Promise(r=>tcp.close(r));
const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws; const requests=[];
try {
  let pages;for(let i=0;i<80;i++){try{pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(pages.length)break;}catch{}await wait(100);}
  assert.ok(pages?.length);ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let sequence=0;const pending=new Map(),errors=[];
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.method==='Network.requestWillBeSent' && m.params.request.url.includes(`/security-center/local-records/${recordId}?`)) requests.push({at:Date.now(),url:m.params.request.url});if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const x=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(x.exceptionDetails)throw Error(x.exceptionDetails.exception?.description??x.exceptionDetails.text);return x.result.value;};
  const until=async expression=>{for(let i=0;i<500;i++){if(await evaluate(expression))return;await wait(100);}throw Error(`Timeout: ${expression}`);};
  const openRecord=async id=>{await send('Page.navigate',{url:`${base}/record-tracking?record=${id}`});await until(`!!document.querySelector('[data-detail-tab="trace"]')`);await evaluate(`document.querySelector('[data-detail-tab="trace"]').click()`);await until(`document.querySelectorAll('[data-trace-row]').length>0`);};
  await send('Page.enable');await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1120,deviceScaleFactor:1,mobile:false});
  await send('Network.enable');
  await openRecord(recordId);
  await wait(1500);
  const counts=()=>requests.filter(r=>r.url.includes('includeSystemEvidence=false')&&r.url.includes('limit=250')).length;
  const initial=counts();
  const filters=await evaluate(`document.querySelector('[aria-label="Trace 类型筛选"]').innerText`);
  await evaluate(`[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='刷新').at(-1).click()`);
  await wait(1000);
  const afterRefresh=counts();
  await wait(17000);
  const afterPolling=counts();
  assert.ok(afterRefresh>initial, 'Explicit refresh must revalidate native events within the old 15s cache window');
  assert.ok(afterPolling>afterRefresh, 'Native event polling must continue after explicit refresh');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({pass:true,initial,afterRefresh,afterPolling,filters,browserErrors:errors}));
  await send('Browser.close');
}finally{ws?.close();chrome.kill('SIGTERM');}
