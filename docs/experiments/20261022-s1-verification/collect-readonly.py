import json,sqlite3,subprocess
from pathlib import Path
base=Path('/home/zhongyule/code');out=Path('/tmp/s1-critical-review-20261022');out.mkdir(exist_ok=True)
rows=json.load(open(base/'AnySentry/docs/experiments/20261021-kernel-comparison/counts.json'))
def ch(q):
 s=subprocess.check_output(['docker','exec','anysentry-clickhouse-1','clickhouse-client','--query',q],text=True)
 return [json.loads(x) for x in s.splitlines() if x]
for r in rows:
 if '-s1-' not in r['run']:continue
 a,b=r['window_ms'];root=r['root_pid']
 db=base/'agentsight/.local/harbor-recordings'/r['run']/'record.db';c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 ss=[dict(x) for x in c.execute("select id,pid,comm,action,target,timestamp_ms,details_json from audit_events where audit_type in ('process','file','network') and timestamp_ms between ? and ?",(a,b))]
 for x in ss:x['details']=json.loads(x.pop('details_json'))
 aa=ch(f"SELECT eventId,argMax(at,decisionRevision) event_at,argMax(processPid,decisionRevision) pid,argMax(processPpid,decisionRevision) ppid,argMax(eventKind,decisionRevision) kind,argMax(subject,decisionRevision) subject,argMax(attributes,decisionRevision) attrs FROM anysentry.events WHERE at BETWEEN {a} AND {b} AND eventKind IN ('ToolExec','FileAccess','FileDelete','Egress','ProcessExit') GROUP BY eventId FORMAT JSONEachRow")
 for x in aa:x['attrs']=json.loads(x['attrs']);x['pid']=int(x['pid']);x['ppid']=int(x['ppid']);x['event_at']=int(x['event_at'])
 edges=[(x['pid'],x['ppid']) for x in aa if x['kind']=='ToolExec']+[(x['pid'],int(x['details'].get('ppid',0))) for x in ss if x['action']=='exec']
 fam={root}
 for _ in range(40):
  new=fam|{p for p,pp in edges if pp in fam}
  if new==fam:break
  fam=new
 aa=[x for x in aa if x['pid'] in fam];ss=[x for x in ss if x['pid'] in fam]
 name={'870642':'db-wal-recovery','870777':'fix-git','870579':'polyglot-c-py'}[str(root)]
 (out/(name+'.json')).write_text(json.dumps({'run':r['run'],'root_pid':root,'window_ms':[a,b],'AnySentry':aa,'AgentSight':ss},ensure_ascii=False))
 print(name,'ANY',len(aa),'AS',len(ss))
 print('ANY_TASK_FILES',sorted({x['attrs'].get('path',x['subject']) for x in aa if x['kind']=='FileAccess' and '/app/' in x['subject']})[:40])
 print('AS_TASK_FILES',sorted({x['target'] for x in ss if x['action']=='write' and '/app/' in (x['target'] or '')})[:40])
 print('ANY_EXEC',[(x['pid'],x['subject'][:130]) for x in aa if x['kind']=='ToolExec'][:30])
