// Real-model, bounded smoke test: two threads share one Codex app-server process.
// Prints only test identifiers/status and our synthetic marker responses. No auth/config dump.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
const cwd = process.argv[2];
if (!cwd?.startsWith('/tmp/anysentry-codex-ws-live-')) throw Error('Pass the dedicated temporary test directory');
const child = spawn('codex', ['app-server'], {cwd, stdio:['pipe','pipe','pipe']});
const pending = new Map();
const turns = new Map();
let serial = 0;
let stderrBytes = 0;
let toolResults = 0;
const expected = [];
child.stderr.on('data', data => { stderrBytes += data.length; });
const lines = createInterface({input: child.stdout});
const send = value => child.stdin.write(JSON.stringify(value)+'\n');
lines.on('line', line => {
  let value; try { value = JSON.parse(line); } catch { return; }
  if (value.id !== undefined && pending.has(value.id)) {
    const p = pending.get(value.id); pending.delete(value.id); clearTimeout(p.timer);
    if (value.error) p.reject(Error(JSON.stringify(value.error))); else p.resolve(value.result);
  } else if (value.id !== undefined && value.method) {
    // Never grant an unexpected tool/permission request in this no-tools smoke test.
    send({id:value.id,error:{code:-32000,message:'No tools or approvals permitted in this test'}});
  } else if (value.method === 'turn/completed') {
    turns.set(value.params.turn.id, value.params.turn);
  } else if (value.method === 'item/completed' && value.params.item?.type === 'commandExecution') {
    toolResults++;
  }
});
function rpc(method, params) {
  return new Promise((resolve,reject)=>{
    const id=++serial;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},60000);
    pending.set(id,{resolve,reject,timer}); send({id,method,params});
  });
}
async function turn(threadId, marker, tool = false) {
  const prompt = tool
    ? `这是网络明文监测测试。只调用一次命令执行工具，执行 /usr/bin/printf '${marker}\\n'。不要读写文件，不要重试；成功后回复命令输出，失败则直接报告失败。`
    : `这是网络明文监测测试。不要使用工具，不要读取文件，只回复：${marker}`;
  const result=await rpc('turn/start',{threadId,input:[{type:'text',text:prompt}],effort:'low'});
  const id=result.turn.id;
  const deadline=Date.now()+90000;
  while(!turns.has(id) && Date.now()<deadline) await new Promise(r=>setTimeout(r,200));
  const done=turns.get(id);
  if(!done) throw Error('Turn completion timeout: '+id);
  console.log(JSON.stringify({threadId,turnId:id,marker,status:done.status,
    ...(done.error ? {error:done.error} : {})}));
  expected.push({threadId,turnId:id,prompt,tool,status:done.status});
  if(done.status!=='completed' && !tool) throw Error('Turn did not complete');
}
async function verifyApi() {
  const deadline = Date.now()+60000;
  let failure = 'not yet projected';
  while(Date.now()<deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:29653/security-center/local-records?limit=500',{signal:AbortSignal.timeout(10000)})).json();
      const requests = [];
      for(const id of new Set(expected.map(e=>e.threadId))) {
        const record=list.data.items.find(r=>r.sessionId===id);
        if(!record) throw Error('Session not discovered: '+id);
        const detail=await (await fetch(`http://127.0.0.1:29653/security-center/local-records/${record.recordId}?limit=100&includeSystemEvidence=false&includeObservedLlmRequests=true&includeObservedLlmRequestContent=true`,{signal:AbortSignal.timeout(10000)})).json();
        requests.push(...detail.data.observedLlmRequests);
      }
      for(const e of expected) {
        const matches=requests.filter(r=>r.sessionId===e.threadId && r.turnId===e.turnId
          && r.content===e.prompt && r.contentSha256===createHash('sha256').update(e.prompt).digest('hex')
          && r.contentAvailability==='available' && r.capture?.method==='ebpf_rustls');
        if(!matches.length) throw Error('Missing exact content/Turn match: '+e.turnId);
      }
      const expectedTurns = new Set(expected.map(e=>e.turnId));
      if(requests.some(r=>!expectedTurns.has(r.turnId))) throw Error('Unexpected request Turn in test sessions');
      console.log(JSON.stringify({apiVerified:true,userTurns:expected.length,exactContentHashMatches:expected.length,
        observedRequests:requests.length,toolResults,pids:[...new Set(requests.map(r=>r.pid))],
        workerTids:[...new Set(requests.map(r=>r.tid))],failedTurns:expected.filter(e=>e.status!=='completed').length}));
      return;
    } catch(e) { failure=e.message; }
    await new Promise(r=>setTimeout(r,1500));
  }
  throw Error(failure);
}
try {
  await rpc('initialize',{clientInfo:{name:'anysentry_ws_smoke',version:'1.0.0'},capabilities:{experimentalApi:true}});
  send({method:'initialized',params:{}});
  const params={cwd,sandbox:'read-only',approvalPolicy:'never',ephemeral:false,
    ...(process.env.ANYSENTRY_TEST_MODEL ? {model:process.env.ANYSENTRY_TEST_MODEL} : {}),
    developerInstructions:'This is a network-observation smoke test. Never use tools, files, subagents or commands. Reply only with the requested marker.'};
  const a=await rpc('thread/start',params);
  const b=await rpc('thread/start',params);
  const aId=a.thread.id ?? a.thread.sessionId;
  const bId=b.thread.id ?? b.thread.sessionId;
  console.log(JSON.stringify({appServerPid:child.pid,threads:[aId,bId],startedAt:Date.now()}));
  if(process.argv[3]==='--concurrent-tools' || process.argv[3]==='--tools-only') {
    if(process.argv[3]!=='--tools-only') {
    await Promise.all([turn(aId,'ANYSENTRY_WS_FIX_A1'),turn(bId,'ANYSENTRY_WS_FIX_B1')]);
    await Promise.all([turn(aId,'ANYSENTRY_WS_FIX_A2'),turn(bId,'ANYSENTRY_WS_FIX_B2')]);
    await turn(aId,'ANYSENTRY_WS_FIX_A3');
    }
    const c=await rpc('thread/start',{...params,developerInstructions:'Run only the single printf requested by the test. Do not read or modify files, retry, or delegate. If the sandbox rejects the command, report that and stop.'});
    await turn(c.thread.id ?? c.thread.sessionId,'ANYSENTRY_WS_FIX_TOOL',true);
  } else {
    for (const [id,marker] of [[aId,'ANYSENTRY_WS_FIX_A1'],[bId,'ANYSENTRY_WS_FIX_B1'],[aId,'ANYSENTRY_WS_FIX_A2'],[bId,'ANYSENTRY_WS_FIX_B2'],[aId,'ANYSENTRY_WS_FIX_A3']]) await turn(id,marker);
  }
  await verifyApi();
} finally {
  for(const p of pending.values()) clearTimeout(p.timer);
  child.stdin.end(); child.kill('SIGTERM');
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000); timer.unref();
  child.once('exit',()=>clearTimeout(timer));
  console.log(JSON.stringify({testFinished:true,stderrBytes}));
}
