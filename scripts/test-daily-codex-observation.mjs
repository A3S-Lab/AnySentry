// Real, bounded Codex CLI observation test. Does not modify application config/services.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
const dir = await fs.mkdtemp('/tmp/anysentry-daily-codex-');
const stamp = Date.now().toString(36);
const states = [];
const headless = process.argv.includes('--headless');
const base = 'http://127.0.0.1:29653/security-center/';
let busy = false;
async function api(path) {
  const r = await fetch(base + path, {signal:AbortSignal.timeout(15000)});
  const b = await r.json();
  if (!r.ok || b.code !== 200) throw new Error(`API ${r.status}/${b.code}`);
  return b.data;
}
async function sample(details = false) {
  if (details) while (busy) await new Promise(r=>setTimeout(r,100));
  if (busy) return;
  busy = true;
  try {
    const list = await api('local-records?limit=500');
    for (const s of states) {
      const item = list.items.find(i => i.sessionId === s.sessionId);
      if (!item) continue;
      s.recordId = item.recordId;
      const snap = {at:Date.now(),status:item.processStatus,pid:item.processPid};
      if (details) {
        const d = await api(`local-records/${s.recordId}?limit=200&includeSystemEvidence=true&evidenceLimit=1000&includeObservedLlmRequests=true&includeObservedLlmRequestContent=false`);
        await fs.writeFile(join(dir, `${s.name}-detail.json`), JSON.stringify(d), {mode:0o600});
        snap.binding = d.systemEvidence?.binding;
        snap.counts = d.systemEvidence?.counts;
        snap.requests = d.observedLlmRequests?.length ?? 0;
        snap.kinds = (d.systemEvidence?.events ?? []).reduce((o,e) => (o[e.eventKind]=(o[e.eventKind]??0)+1,o),{});
      }
      s.samples.push(snap);
    }
  } catch(e) { console.log(JSON.stringify({sampleError:e.message})); }
  finally { busy = false; }
}
async function run(name, markers, resume) {
  const commands = markers.map((m,i) => i === 1
    ? `/usr/bin/bash -c '/usr/bin/printf "%s\\n" "${m}"; /usr/bin/sleep 15'`
    : `/usr/bin/printf '%s\\n' '${m}'; /usr/bin/sleep 15`);
  const prompt = markers.length ? `This is an authorized local observability test. Do not read or modify project files. Execute EXACTLY these commands, each in its own shell tool invocation, in order. Do not execute any other commands or delegate. Wait for each command to finish. Then reply only OK.\n${commands.join('\n')}`
    : 'This is an observability negative control. Do not use any tool or run any command. Reply only OK.';
  const s = {name,markers,commands,prompt,startedAt:Date.now(),samples:[]}; states.push(s);
  const args = ['exec', ...(resume ? ['resume',resume] : ['--sandbox','read-only','--cd',dir]), '--skip-git-repo-check','--json',prompt];
  const log = createWriteStream(join(dir,`${name}.jsonl`),{mode:0o600});
  const err = createWriteStream(join(dir,`${name}.stderr`),{mode:0o600});
  const child = spawn('codex',args,{cwd:dir,stdio:['ignore','pipe','pipe']});
  s.launcherPid = child.pid;
  child.stderr.pipe(err); child.stdout.pipe(log);
  let pending = '';
  child.stdout.on('data',chunk => {
    pending += chunk;
    let index;
    while ((index=pending.indexOf('\n')) >= 0) {
      const line=pending.slice(0,index);pending=pending.slice(index+1);
      try {
        const r=JSON.parse(line);
        if (r.type==='thread.started') { s.sessionId=r.thread_id; console.log(JSON.stringify({name,sessionId:s.sessionId,stage:'started'})); }
      } catch {}
    }
  });
  const timer = setTimeout(()=>{s.timeout=true;child.kill('SIGTERM');},300000);
  const killTimer = setTimeout(()=>child.kill('SIGKILL'),310000);
  const code = await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  clearTimeout(timer);clearTimeout(killTimer);
  s.code=code;s.finishedAt=Date.now();
  await new Promise(r=>log.end(r)); await new Promise(r=>err.end(r));
  console.log(JSON.stringify({name,code,sessionId:s.sessionId,stage:'finished'}));
  if (!headless) await sample(true);
  return s;
}
console.log(JSON.stringify({directory:dir,stamp,model:'existing user configuration',scope:'daily Codex; no service restart',headless}));
await fs.writeFile(join(dir,'manifest.json'),JSON.stringify({stamp,startedAt:Date.now()}),{mode:0o600});
const interval = headless ? undefined : setInterval(()=>void sample(false),5000);
try {
  await run('no-tools',[]);
  const a=await run('sequential',[`DAILY_${stamp}_A1`,`DAILY_${stamp}_A2`,`DAILY_${stamp}_A3`]);
  await Promise.all([run('parallel-left',[`DAILY_${stamp}_B1`]),run('parallel-right',[`DAILY_${stamp}_C1`])]);
  if (a.sessionId && a.code===0) await run('resume',[`DAILY_${stamp}_A4`],a.sessionId);
  // Negative control from the harness, outside all tested Codex process families.
  execFileSync('/usr/bin/printf',['%s\n',`DAILY_${stamp}_OUTSIDE`]);
  for(let i=0;i<3;i++) {
    await new Promise(r=>setTimeout(r,30000));
    if (!headless || i===2) await sample(true);
  }
} finally {
  clearInterval(interval);
  while(busy) await new Promise(r=>setTimeout(r,100));
  await fs.writeFile(join(dir,'results.json'),JSON.stringify({stamp,states},null,2),{mode:0o600});
  console.log(`RESULTS ${dir}/results.json`);
}
