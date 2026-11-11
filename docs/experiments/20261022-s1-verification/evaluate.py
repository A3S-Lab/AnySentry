from pathlib import Path
import json,re,collections,hashlib
B=Path('/home/zhongyule/code/AnySentry');O=B/'docs/experiments/20261022-s1-verification';O.mkdir(parents=True,exist_ok=True)
claims=json.load(open(B/'docs/experiments/20261022-s1-claims/claims.json'))
raw={t:json.load(open('/tmp/s1-critical-review-20261022/'+t+'.json')) for t in claims['sources']}
def command(e,side):
 a=e.get('attrs',e.get('details',{}));v=a.get('command') or a.get('argv') or a.get('full_command') or e.get('subject','')
 return ' '.join(v) if isinstance(v,list) else str(v)
def isexec(e,side):return e.get('kind')=='ToolExec' and e['attrs'].get('exec_confirmed') is True if side=='AnySentry' else e.get('action')=='exec'
def normalized(c):
 # Only normalize the executable path. Do not search a shell script for an inner program.
 c=c.strip();first,_,rest=c.partition(' ')
 return first.rsplit('/',1)[-1]+' '+rest

def atom(label,typ,pattern=None,paths=None,reason=None):return {'label':label,'type':typ,'command_regex':pattern,'paths':paths,'limitation':reason}
def prog(label,p):return atom(label,'exec',p)
def wr(label,*paths):return atom(label,'writable_open',paths=list(paths),reason='可写打开支持文件访问意图，不证明后续写入字节、rename 或内容正确。')
def rd(label,*paths):return atom(label,'readable_open',paths=list(paths),reason='只检查明确的读取打开标记；未找到不等于未发生读取。')
native_times={}
for task,source in claims['sources'].items():
 for line in Path(source['wire_path']).open():
  o=json.loads(line);e=o.get('event',{})
  if o.get('type')=='context.append_loop_event' and e.get('type') in ['tool.call','tool.result']:
   native_times.setdefault(task,{}).setdefault(e.get('toolCallId'),{})[e['type']]=o.get('time')
def windows(claim):
 out=[]
 for ref in claim['basis']:
  ts=native_times[claim['task']].get(ref['call_id'],{})
  if ts.get('tool.call') is not None and ts.get('tool.result') is not None:out.append([ts['tool.call']-5000,ts['tool.result']+5000])
 return out
R={
'fix-git-K1':[prog('git reflog 实际执行',r'^git reflog(?: |$)'),rd('reflog 读取打开','/app/personal-site/.git/logs/HEAD')],
'fix-git-K2':[prog('git merge 实际执行',r'^git merge(?: |$)'),wr('冲突文件可写打开','/app/personal-site/_includes/about.md'),wr('MERGE_HEAD 可写打开','/app/personal-site/.git/MERGE_HEAD')],
'fix-git-K3':[rd('about.md 读取打开','/app/personal-site/_includes/about.md')],
'fix-git-K4':[wr('about.md 可写打开','/app/personal-site/_includes/about.md')],
'fix-git-K5':[prog('git add 实际执行',r'^git add(?: |$)'),prog('git commit 实际执行',r'^git commit(?: |$)'),wr('index/index.lock 可写打开','/app/personal-site/.git/index','/app/personal-site/.git/index.lock'),wr('对象文件可写打开','/app/personal-site/.git/objects/'),wr('master 引用/锁可写打开','/app/personal-site/.git/refs/heads/master','/app/personal-site/.git/refs/heads/master.lock')],
'fix-git-K6':[prog('grep 实际执行',r'^grep(?: |$)'),rd('任务文件读取打开','/app/personal-site/_includes/about.md','/app/personal-site/_layouts/default.html')],
'db-wal-recovery-K1':[prog('xxd 实际执行',r'^xxd(?: |$)'),prog('WAL 分析 Python 实际执行',r'^python3(?:\.\d+)? .*main\.db-wal'),rd('WAL 读取打开','/app/main.db-wal')],
'db-wal-recovery-K2':[prog('cp 实际执行',r'^cp(?: |$)'),wr('main.db.orig 可写打开','/app/main.db.orig'),wr('main.db-wal.orig 可写打开','/app/main.db-wal.orig')],
'db-wal-recovery-K3':[prog('解码写回 Python 实际执行',r'^python3(?:\.\d+)? .*main\.db-wal\.orig'),rd('WAL 备份读取打开','/app/main.db-wal.orig'),wr('WAL 可写打开','/app/main.db-wal')],
'db-wal-recovery-K4':[prog('SQLite 数据库命令实际执行',r'^sqlite3 main\.db(?: |$)'),rd('数据库读取打开','/app/main.db')],
'db-wal-recovery-K5':[prog('JSON 导出 Python 实际执行',r'^python3(?:\.\d+)? .*import sqlite3,\s*json'),rd('主库读取打开','/app/main.db'),wr('recovered.json 可写打开','/app/recovered.json'),rd('JSON 读取打开','/app/recovered.json')],
'db-wal-recovery-K6':[prog('JSON 校验 Python 实际执行',r'^python3(?:\.\d+)? .*json\.load'),rd('JSON 读取打开','/app/recovered.json')],
'polyglot-c-py-K1':[wr('main.py.c 可写打开','/app/polyglot/main.py.c')],
'polyglot-c-py-K2':[prog('gcc 实际执行',r'^gcc(?: |$)'),rd('源文件读取打开','/app/polyglot/main.py.c'),wr('cmain 可写打开','/app/polyglot/cmain')],
'polyglot-c-py-K3':[atom('失败路径查找/exec 的完整证据','unsupported',reason='既有记录不提供完整失败 syscall/errno，不能从127反推ENOENT。')],
'polyglot-c-py-K4':[prog('apt-get 实际执行',r'^apt-get(?: |$)'),prog('dpkg 实际执行',r'^dpkg(?: |$)'),wr('包管理目录可写打开','/var/lib/dpkg/','/var/lib/apt/','/var/cache/apt/')],
'polyglot-c-py-K5':[atom('归属于 apt 及其后代的远端获取链','unsupported',reason='网络总数含模型及其他流量；本轮不以连接总数确认 apt 下载，需单独逐连接核验。')],
'polyglot-c-py-K6':[prog('Python 解释执行 main.py.c',r'^python3(?:\.\d+)? main\.py\.c(?: |$)'),rd('源文件读取打开','/app/polyglot/main.py.c')],
'polyglot-c-py-K7':[prog('cmain 实际执行',r'^cmain(?: |$)')],
'polyglot-c-py-K8':[atom('stdout 管道 FD 流向','unsupported',reason='既有 exec/open 记录缺少完整 pipe/dup/write 数据流，命令文本不代替FD证据。')]
}

def match(e,side,r):
 if r['type']=='exec':return isexec(e,side) and bool(re.search(r['command_regex'],normalized(command(e,side)),re.S))
 if r['type'] not in ['writable_open','readable_open']:return False
 a=e.get('attrs',e.get('details',{}));isfile=e.get('kind')=='FileAccess' if side=='AnySentry' else e.get('action')=='write' and a.get('event')=='FILE_OPEN'
 if not isfile:return False
 path=a.get('path') or a.get('filepath') or e.get('target') or ''
 if not any(path.startswith(p) if p.endswith('/') else path==p for p in r['paths']):return False
 if side=='AnySentry':
  mode=a.get('accessMode');return mode in (['write_only','read_write'] if r['type']=='writable_open' else ['read_only','read_write'])
 return a.get('write' if r['type']=='writable_open' else 'read') is True

def reference(e,side):
 return {'event_id':e.get('eventId',e.get('id')),'pid':e['pid'],'at_ms':e.get('event_at',e.get('timestamp_ms')),'kind':e.get('kind',e.get('action')),'target_or_command':(command(e,side) if isexec(e,side) else e.get('attrs',e.get('details',{})).get('path') or e.get('target') or e.get('subject',''))[:260]}
res=[]
for c in claims['claims']:
 atoms=R[c['id']];row={'claim_id':c['id'],'task':c['task'],'title':c['title'],'priority':c['priority'],'independent_verification':'not_performed','atoms':[],'system_results':{},'candidate_call_windows_ms':windows(c),'window_tolerance_ms':5000}
 for a in atoms:
  z=dict(a);z['systems']={}
  for side in ['AnySentry','AgentSight']:
   all_hits=[e for e in raw[c['task']][side] if match(e,side,a)]
   hits=[e for e in all_hits if any(lo <= e.get('event_at',e.get('timestamp_ms')) <= hi for lo,hi in windows(c))]
   z['systems'][side]={'status':'unsupported_by_existing_fields' if a['type']=='unsupported' else 'recorded' if hits else 'not_found_in_scoped_recording','task_scope_count':len(all_hits),'task_scope_examples':[reference(e,side) for e in all_hits[:6]],'count':len(hits),'examples':[reference(e,side) for e in hits[:6]]}
  row['atoms'].append(z)
 for side in ['AnySentry','AgentSight']:
  hits=sum(a['systems'][side]['status']=='recorded' for a in row['atoms'])
  row['system_results'][side]={'status':'partial_support' if hits else 'insufficient_fields' if all(a['type']=='unsupported' for a in atoms) else 'no_matching_evidence','matched_atoms':hits,'total_atoms':len(atoms),'task_scope_matched_atoms':sum(a['systems'][side]['task_scope_count']>0 for a in row['atoms']),'full_claim_confirmed':False}
 res.append(row)
report={'schema':'s1-retrospective-evidence-review/v1','date':'2026-10-22','claim_file_sha256':hashlib.sha256((B/'docs/experiments/20261022-s1-claims/claims.json').read_bytes()).hexdigest(),'scope':'历史S1目标进程家族及Harbor窗口；非独立ground truth，不提供全命题通过率。','matching_scope':'每条命题引用调用的开始至返回，前后各放宽5秒；后台安装包含WaitFor区间。时间相关只是候选支撑，不是确定call绑定。','preregistered_before_original_experiment':False,'results':res}
(O/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
for task in raw:
 rr=[x for x in res if x['task']==task]
 print('TASK',task)
 for r in rr:print(r['claim_id'],[(s,r['system_results'][s]['matched_atoms'],r['system_results'][s]['total_atoms']) for s in ['AnySentry','AgentSight']])
 for s in ['AnySentry','AgentSight']:
  matches=sum(a['systems'][s]['status']=='recorded' for r in rr for a in r['atoms']);total=sum(a['type']!='unsupported' for r in rr for a in r['atoms']);print('CHECKPOINTS',s,matches,total)
