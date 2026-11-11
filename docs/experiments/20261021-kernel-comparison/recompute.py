import json, sqlite3, subprocess, collections
from pathlib import Path
from datetime import datetime
base=Path('/home/zhongyule/code')
root=base/'agentsight/.local/harbor-recordings'
results=[]
def ch(q):
 r=subprocess.run(['docker','exec','anysentry-clickhouse-1','clickhouse-client','--query',q],capture_output=True,text=True,check=True)
 return [json.loads(l) for l in r.stdout.splitlines() if l]
def ms(t):return int(datetime.fromisoformat(t).timestamp()*1000)
for rec in sorted(root.iterdir()):
 if not rec.name.startswith(('kimi-s1-','kimi-s2-','kimi-s3-music','kimi-s3-shadow','kimi-s3-legacy-utility')):continue
 db=rec/'record.db';job=base/'terminal-bench/.harbor-jobs'/rec.name
 rr=list(job.glob('*/result.json'))
 if not db.exists() or not rr:continue
 r=json.load(rr[0].open());phase=r.get('agent_execution') or {}
 if not phase.get('finished_at'):continue
 since,until=ms(phase['started_at'])-5000,ms(phase['finished_at'])+10000
 c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 pid=c.execute('select pid,count(*) n from llm_calls group by pid order by n desc limit 1').fetchone()['pid']
 ar=[dict(x) for x in c.execute("select id,pid,comm,action,target,details_json from audit_events where audit_type in ('process','file','network') AND timestamp_ms BETWEEN ? AND ?",(since,until))]
 ae=[(int(x['pid']),int(json.loads(x['details_json']).get('ppid',0))) for x in ar if x['action']=='exec' and x['pid']]
 ex=ch(f"SELECT eventId,argMax(processPid,decisionRevision) pid,argMax(processPpid,decisionRevision) ppid FROM anysentry.events WHERE at BETWEEN {since} AND {until} AND eventKind='ToolExec' GROUP BY eventId FORMAT JSONEachRow")
 edges=ae+[(int(x['pid']),int(x['ppid'])) for x in ex]
 fam={int(pid)}
 for _ in range(40):
  new=fam|{p for p,pp in edges if pp in fam}
  if new==fam:break
  fam=new
 pids=','.join(map(str,sorted(fam)))
 an=ch(f"SELECT eventId,argMax(eventKind,decisionRevision) kind,argMax(processPid,decisionRevision) pid,argMax(processPpid,decisionRevision) ppid,argMax(JSONExtractBool(attributes,'exec_confirmed'),decisionRevision) exec_confirmed FROM anysentry.events WHERE at BETWEEN {since} AND {until} AND processPid IN ({pids}) AND eventKind IN ('ToolExec','ProcessExit','FileAccess','FileDelete','Egress') GROUP BY eventId FORMAT JSONEachRow")
 asc=collections.Counter((x['action'] if x['action'] in ['exec','exit'] else 'file' if x['action']=='write' else x['action']) for x in ar if x['pid'] in fam)
 anc=collections.Counter(x['kind'] for x in an)
 ap={int(x['pid']) for x in an if x['kind']=='ToolExec'};sp={int(x['pid']) for x in ar if x['action']=='exec' and x['pid'] in fam}
 result={'run':rec.name,'root_pid':pid,'window_ms':[since,until],'family_pids':len(fam),'AnySentry':dict(anc),'AnySentry_exec_confirmed':dict(collections.Counter(str(x.get('exec_confirmed')) for x in an if x['kind']=='ToolExec')),'AgentSight':dict(asc),'exec_unique_pids':{'AnySentry':len(ap),'AgentSight':len(sp),'intersection':len(ap&sp),'only_any':len(ap-sp),'only_as':len(sp-ap)}}
 results.append(result);print(json.dumps(result),flush=True)
Path('/tmp/s1s2s3-kernel-record-counts-20261021.json').write_text(json.dumps(results,indent=2))
