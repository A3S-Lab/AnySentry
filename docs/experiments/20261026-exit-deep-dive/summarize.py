from pathlib import Path
import json,sqlite3,subprocess,collections,hashlib,sys
from datetime import datetime
B=Path('/home/zhongyule/code/terminal-bench');C=B.parent
O=Path(sys.argv[1]) if len(sys.argv)>1 else Path('/home/zhongyule/code/terminal-bench/eval/s1-exit-fix-20261026-144446')
m=json.loads((O/'runs.json').read_text()) if (O/'runs.json').exists() else {'root':str(O),'runs':[{'task':'fix-git','job':'kimi-exit-fix-fix-git-20261026-144446'},{'task':'db-wal-recovery','job':'kimi-exit-fix-db-wal-recovery-20261026-144446'},{'task':'polyglot-c-py','job':'kimi-exit-fix-polyglot-c-py-20261026-144446'}]}
def ms(s):return int(datetime.fromisoformat(s).timestamp()*1000)
def ch(q):
 p=subprocess.run(['docker','exec','anysentry-clickhouse-1','clickhouse-client','--query',q],capture_output=True,text=True,check=True)
 return [json.loads(l) for l in p.stdout.splitlines() if l]
results=[]
task_counts=collections.Counter(run['task'] for run in m['runs'])
for run in m['runs']:
 job=B/'.harbor-jobs'/run['job'];rr=list(job.glob('*/result.json'))
 if not rr:
  print('WAITING',run['task'],flush=True);continue
 r=json.load(rr[0].open());a=r.get('agent_execution') or {}
 if not a.get('finished_at'):
  print('WAITING',run['task'],flush=True);continue
 since,until=ms(a['started_at'])-5000,ms(a['finished_at'])+60000
 rec=C/'agentsight/.local/harbor-recordings'/run['job'];dep=json.load((rec/'deployment.json').open());root=int(dep['host_pid'])
 conn=sqlite3.connect('file:'+str(rec/'record.db')+'?mode=ro',uri=True);conn.row_factory=sqlite3.Row
 ar=[dict(x) for x in conn.execute("select id,pid,comm,action,target,timestamp_ms,details_json from audit_events where audit_type in ('process','file','network') and timestamp_ms between ? and ?",(since,until))]
 for x in ar:x['details']=json.loads(x.pop('details_json'))
 an=ch(f"SELECT eventId,argMax(at,decisionRevision) event_at,argMax(processPid,decisionRevision) pid,argMax(processPpid,decisionRevision) ppid,argMax(process,decisionRevision) process,argMax(processInstanceKey,decisionRevision) processInstanceKey,argMax(eventKind,decisionRevision) kind,argMax(subject,decisionRevision) subject,argMax(attributes,decisionRevision) attrs FROM anysentry.events WHERE at BETWEEN {since} AND {until} AND eventKind IN ('ToolExec','ProcessExit','FileAccess','FileDelete','Egress') GROUP BY eventId FORMAT JSONEachRow")
 for x in an:x['pid']=int(x['pid']);x['ppid']=int(x['ppid']);x['attrs']=json.loads(x['attrs']);x['event_at']=int(x['event_at']);x['process']=json.loads(x['process'] or '{}')
 edges=[(x['pid'],x['process'].get('creationPpid') or x['ppid']) for x in an if x['kind']=='ToolExec']+[(x['pid'],int(x['details'].get('ppid',0))) for x in ar if x['action']=='exec']
 fam={root}
 for _ in range(40):
  new=fam|{p for p,pp in edges if pp in fam}
  if new==fam:break
  fam=new
 an=[x for x in an if x['pid'] in fam];ar=[x for x in ar if x['pid'] in fam]
 def cmd(e,side):
  z=e['attrs'] if side=='AnySentry' else e['details'];v=z.get('argv') or z.get('command') or z.get('full_command') or e.get('subject','');return ' '.join(v) if isinstance(v,list) else str(v)
 # Select only native sessions matching this task's prompt and this execution window.
 instruction=(C/'terminal-bench-2-1/tasks'/run['task']/'instruction.md').read_text().strip()
 natives=[]
 paths={x['file'] for x in dep.get('native',[]) if x.get('file')}
 for path in paths:
  p=Path(path)
  if not p.exists():continue
  first=None
  for line in p.open():
   j=json.loads(line)
   if j.get('type')=='turn.prompt':first=j;break
  if not first or not since<=first.get('time',0)<=until:continue
  text='\n'.join(x.get('text','') for x in first.get('input',[]) if x.get('type')=='text')
  if not text.strip().startswith(instruction[:65]):continue
  counts=collections.Counter();tools=[];tin=tout=0
  for lineno,line in enumerate(p.open(),1):
   j=json.loads(line);counts[j.get('type')]+=1
   if j.get('type')=='usage.record':
    u=j.get('usage',{});tin+=sum(u.get(k,0) for k in ['inputOther','inputCacheRead','inputCacheCreation']);tout+=u.get('output',0)
   if j.get('type')=='context.append_loop_event' and j.get('event',{}).get('type') in ['tool.call','tool.result']:
    e=j['event'];tools.append({'line':lineno,'time':j.get('time'),'type':e['type'],'call_id':e.get('toolCallId'),'tool':e.get('name'),'args':e.get('args'),'result':e.get('result')})
  natives.append({'path':str(p),'session_id':p.parents[2].name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'counts':dict(counts),'tokens_in':tin,'tokens_out':tout,'tools':tools})
 ac=collections.Counter(x['kind'] for x in an);sc=collections.Counter(x['action'] for x in ar)
 old={'fix-git':[29,36,14,30],'db-wal-recovery':[21,30,7,22],'polyglot-c-py':[397,240,112,218]}.get(run['task'],[0,0,0,0])
 result={'task':run['task'],'job':run['job'],'root_pid':root,'window_ms':[since,until],'agent_execution':a,'reward':(r.get('verifier_result') or {}).get('rewards'),'exception':(r.get('exception_info') or {}).get('exception_type'),'agent_seconds':round((ms(a['finished_at'])-ms(a['started_at']))/1000,1),'AnySentry':dict(ac),'AnySentry_exec_confirmed':sum(x['kind']=='ToolExec' and x['attrs'].get('exec_confirmed') is True for x in an),'AgentSight':dict(sc),'prior_exec_exit':old,'native_sessions':[dict(x,tools=None) for x in natives],'model_records':{'AgentSight':dict(conn.execute("select count(*) n,sum(request_body_json is not null) req,sum(response_body_json is not null) resp from llm_calls").fetchone())}}
 # Local task-only working evidence; contains no auth configuration or model request bodies.
 evidence_name=run['task'] if task_counts[run['task']]==1 else run['task']+'-'+run['job']
 (O/(evidence_name+'-evidence.json')).write_text(json.dumps({'run':run,'native':natives,'AnySentry':an,'AgentSight':ar},ensure_ascii=False))
 results.append(result);print(json.dumps(result,ensure_ascii=False),flush=True)
(O/'kernel-summary.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
