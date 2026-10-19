import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const base = process.env.ANYSENTRY_DASHBOARD_URL || 'http://127.0.0.1:29654';
const root = process.env.ANYSENTRY_ANALYSIS_RESULTS || '/tmp/anysentry-session-analysis-20260917';
const recordId = '9b5ae799f42a5187be865217';
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

  const open = async id => {
    await send('Page.navigate', {url: `${base}/record-tracking?record=${id}`});
    await until(`!!document.querySelector('[data-detail-tab="metrics"]')`);
    await evaluate(`document.querySelector('[data-detail-tab="metrics"]').click()`);
    await until(`!!document.querySelector('[data-session-analysis]') && !!document.querySelector('[data-analysis-events] tbody tr')`);
  };
  const setInput = async (label, value) => evaluate(`(()=>{const element=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const select = async (label, value) => evaluate(`(()=>{const element=document.querySelector('[aria-label="${label}"]');element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const button = async text => evaluate(`Array.from(document.querySelectorAll('[data-session-analysis] button')).find(button=>button.innerText.trim()===${JSON.stringify(text)}).click()`);
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false});
  await open(recordId);
  await until(`!document.querySelector('[data-session-analysis]').innerText.includes('正在读取进程资源')`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth+1`),true);
  await writeFile(join(root,'analysis-desktop.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  await setInput('非缓存输入单价','10'); await setInput('缓存综合单价','1'); await setInput('输出单价','20');
  await until(`document.querySelector('[data-analysis-cost]').innerText.startsWith('CNY ')`);
  const estimate=await evaluate(`document.querySelector('[data-analysis-cost]').innerText`);
  await select('分析事件类型','TOOL');
  await until(`[...document.querySelectorAll('[data-analysis-events] tbody tr')].every(row=>row.innerText.includes('工具记录'))`);
  await evaluate(`document.querySelector('[aria-label="放大时间线"]').click()`);
  await until(`!!document.querySelector('[aria-label="时间窗口位置"]')`);
  await select('分析事件来源','Observer');
  await until(`document.querySelectorAll('[data-analysis-events] tbody tr').length===0`);
  await button('重置');
  await until(`document.querySelectorAll('[data-analysis-events] tbody tr').length>0`);
  await evaluate(`document.querySelector('[data-analysis-events] tbody button').click()`);
  await until(`!!document.querySelector('[aria-label="分析事件详情"]')`);
  await button('关闭详情');
  await evaluate(`document.querySelector('[aria-label="评价 4 分"]').click()`);
  await evaluate(`(()=>{const element=document.querySelector('[aria-label="评价说明"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(element,'分析页浏览器测试');element.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await button('保存评价');
  await until(`document.querySelector('[data-session-analysis]').innerText.includes('已保存到当前浏览器')`);
  await open(recordId);
  await until(`document.querySelector('[aria-label="评价 4 分"]').getAttribute('aria-pressed')==='true'`);
  assert.equal(await evaluate(`document.querySelector('[aria-label="评价说明"]').value`),'分析页浏览器测试');
  await button('清除');
  await evaluate(`window.__analysisExport=null;const original=URL.createObjectURL;URL.createObjectURL=function(blob){blob.text().then(text=>window.__analysisExport=JSON.parse(text));return original.call(this,blob);}`);
  await button('导出分析');
  await until(`window.__analysisExport?.schemaVersion==='anysentry.session-analysis.v1'`);
  assert.equal(await evaluate(`'events' in window.__analysisExport`),false,'export excludes raw conversation');
  const before=await evaluate(`window.__analysisExport.loadedEvents`);
  await button('加载更早记录');
  await until(`!document.querySelector('[data-session-analysis]').innerText.includes('加载中…')`);
  await button('导出分析');
  await until(`window.__analysisExport.loadedEvents>${before}`);
  await send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.querySelector('[data-session-analysis]').scrollIntoView()`);
  await until(`document.documentElement.scrollWidth<=innerWidth+1`);
  await writeFile(join(root,'analysis-mobile.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  await evaluate(`document.querySelector('[data-analysis-events]').scrollIntoView()`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),true);
  await writeFile(join(root,'analysis-mobile-timeline.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false});
  await open('28cb7921eb9141ee37cad234');
  await until(`document.querySelector('[data-session-analysis]').innerText.includes('尚无唯一、有效的 Session 进程绑定')`);
  assert.equal(await evaluate(`document.querySelector('[aria-label="评价 4 分"]').getAttribute('aria-pressed')`),'false','reviews isolated per record');
  assert.deepEqual(errors,[]);
  const result={pass:true,estimate,filters:true,zoom:true,eventDetails:true,localReviewPersistence:true,export:true,loadHistory:true,mobile375:true,unboundResources:true,runtimeErrors:errors};
  await writeFile(join(root,'browser-report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  await send('Browser.close');
} finally {
  socket?.close(); chrome.kill(); await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>undefined);
}
