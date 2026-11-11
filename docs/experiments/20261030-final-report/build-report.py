"""Rebuild the four-section report from archived per-event evidence, without new runs.

All tables use archived execution windows. Exit selection uses the union of selected
task-program PIDs, allowing an exit to be counted even when that system missed exec.
"""
from collections import Counter
from datetime import datetime, timezone, timedelta
from html import escape
import json
from pathlib import Path
import shlex
from make_editable import make_editable

CODE = Path('/home/zhongyule/code')
OUT = Path(__file__).resolve().parent
TARGET = CODE / 'AnySentry/docs/terminal-bench-2-1-critical-event-comparison-20261029.html'
EVAL = CODE / 'terminal-bench/eval'
DB = {'xxd', 'cp', 'python3', 'sqlite3', 'file', 'stat', 'rm', 'mv', 'dd', 'base64', 'openssl'}
COMPILER = {'gcc', 'cc1', 'as', 'collect2', 'ld'}


def arguments(event):
    attrs = event.get('attrs', event.get('details', {}))
    value = attrs.get('argv') or attrs.get('full_command') or event.get('subject', '')
    try:
        return value if isinstance(value, list) else shlex.split(value)
    except ValueError:
        return []


def critical(task, args):
    if not args:
        return False
    program = Path(args[0]).name
    if task == 'fix-git':
        return program == 'git'  # Includes git-core helpers, consistently for this task.
    if task == 'db-wal-recovery':
        return program in DB and not any(a in ('--version', '-V') for a in args[1:])
    return program in COMPILER or args[0] == '/app/polyglot/cmain'


def read_run(directory, group, instance=''):
    result = []
    for path in sorted((EVAL / directory).glob('*-evidence.json')):
        data = json.loads(path.read_text())
        task = data['run']['task']
        job = data['run']['job']
        selected = {}
        all_exec = {}
        for side in ('AnySentry', 'AgentSight'):
            events = data[side]
            all_exec[side] = [e for e in events if
                (e.get('kind') == 'ToolExec' and e.get('attrs', {}).get('exec_confirmed') is True)
                if side == 'AnySentry'] if side == 'AnySentry' else [e for e in events if e.get('action') == 'exec']
            selected[side] = [e for e in all_exec[side] if critical(task, arguments(e))]
        pids = {e['pid'] for events in selected.values() for e in events}
        row = {'group': group, 'task': task, 'job': job, 'artifact': str(path), 'counts': {}, 'key_events': {}}
        row['unconfirmed_key_events'] = [
            {'pid': e['pid'], 'event_id': e.get('eventId'), 'argv': arguments(e),
             'exec_confirmed': e.get('attrs', {}).get('exec_confirmed'),
             'argv_incomplete': e.get('attrs', {}).get('argv_incomplete')}
            for e in data['AnySentry'] if e.get('kind') == 'ToolExec'
            and e.get('attrs', {}).get('exec_confirmed') is not True
            and critical(task, arguments(e))]
        for side in ('AnySentry', 'AgentSight'):
            exits = [e for e in data[side] if
                (e.get('kind') == 'ProcessExit' if side == 'AnySentry' else e.get('action') == 'exit')]
            key_exits = [e for e in exits if e['pid'] in pids]
            row['counts'][side] = {'all': [len(all_exec[side]), len(exits)],
                                   'key': [len(selected[side]), len(key_exits)]}
            row['key_events'][side] = {
                'exec': [{'pid': e['pid'], 'argv': arguments(e), 'source_id': e.get('eventId', e.get('id'))} for e in selected[side]],
                'exit': [{'pid': e['pid'], 'source_id': e.get('eventId', e.get('id')),
                          'exit_code': e.get('attrs', e.get('details', {})).get('exit_code')} for e in key_exits]}
        if group == 'S2-G':
            row['instance'] = 'A' if 'twina' in job else 'B'
        elif group in ('S2-P', 'S2-D'):
            marker = 'poly4-gap-r2-' if group == 'S2-P' else 'db4-lifecycle-'
            row['instance'] = job.split(marker)[1].split('-')[0].upper()
        else:
            row['instance'] = instance
        summary = json.loads((path.parent / 'kernel-summary.json').read_text())
        entry = next(x for x in summary if x['job'] == job)
        started = entry['agent_execution']['started_at']
        row['date'] = datetime.fromisoformat(started).astimezone(timezone(timedelta(hours=8))).strftime('%m-%d %H:%M')
        row['reward'] = entry.get('reward')
        row['exception'] = entry.get('exception')
        result.append(row)
    return sorted(result, key=lambda r: (r['instance'], r['task']))


rows = []
for directory, group in [
    ('fix-single-r2-20261030-145744', '单任务'),
    ('db-final-r2-20261027-220101', '单任务'),
    ('poly-c24-check-20261027-205051', '单任务'),
    ('s2-complete-20261027-210405', 'S2-G'),
    ('s2-poly4-gap-r2-20261028-172634', 'S2-P'),
    ('db4-lifecycle-20261028-184452', 'S2-D'),
    ('s1-c24-recheck-20261028-110213', 'S1'),
]:
    rows.extend(read_run(directory, group))


def totals(items):
    return {side: {metric: [sum(r['counts'][side][metric][i] for r in items) for i in (0, 1)]
                   for metric in ('all', 'key')} for side in ('AnySentry', 'AgentSight')}


def pair(value):
    return f'{value[0]} / {value[1]}'


def verdict(counts):
    a, b = counts['AnySentry']['key'], counts['AgentSight']['key']
    if a == b:
        return '所选关键记录持平'
    if all(x >= y for x, y in zip(a, b)):
        return 'AnySentry 所选关键记录更多'
    if all(y >= x for x, y in zip(a, b)):
        return 'AgentSight 所选关键记录更多'
    return 'exec / exit 各有差异'


def explanation(row):
    task, group = row['task'], row['group']
    if row.get('aggregate'):
        return {'S2-G': '与第 1 节 A/B 的同口径合计一致；Git 辅助程序与绝对路径均按同一规则处理。',
                'S2-P': '含编译链和答案程序；只计 B/C/D，A 未完成。关键缺口来自 D 的三次 cmain。',
                'S2-D': 'A/D 评分器超时，B/C reward 1.0；四例均保留作观测对照，不将超时写成评分通过。'}[group]
    if group == '单任务' and task == 'fix-git':
        return ('最新重跑 reward 1.0。AnySentry 和独立原始 Collector 均为 20 条 confirmed + 1 条 unconfirmed Git 记录、21 条 exit；'
                'AgentSight 为 21 条 exec、21 条 exit。PID 676583 已在原窗口入库；此前 confirmed-only 将其排除，不是事件未记录或迟到。')
    if group == '单任务' and task == 'db-wal-recovery':
        return '统一排除 python3/sqlite3 的版本探测；比较实际 WAL 检查、备份、恢复与验证程序。'
    if task == 'polyglot-c-py':
        if group == 'S2-P' and row['instance'] == 'D':
            return '含编译链及重复尝试；AgentSight 缺少 cmain 94、100、500 的 exec/exit。额外缺少循环 Bash exit，未混入本列。'
        return '统一统计 gcc/cc1/as/collect2/ld 与实际 cmain，不再只数答案程序。成功 exec 不代表进程退出码必为 0。'
    if group == 'S2-D':
        state = '评分器超时，仅作观测样本。' if row['instance'] in ('A', 'D') else 'reward 1.0。'
        return state + '恢复/校验主命令的 exit 按双方关键 PID 并集核对，不要求同一家先有 exec。'
    return '统计实际 Git 程序（含 git-core 路径）；关键 exit 按双方关键 PID 并集核对。'


HEADERS = ['实验 / 时间', '任务 / 实例', 'AnySentry 全部 exec / exit', 'AgentSight 全部 exec / exit',
           'AnySentry 关键 exec / exit', 'AgentSight 关键 exec / exit', '记录对照', '说明']


def table(items, aggregate=False):
    body = []
    for r in items:
        c = r['counts']
        label = r['task'] + (' ' + r['instance'] if r.get('instance') else '')
        cells = [escape(r['group'] + ' · ' + r['date']), '<code>' + escape(label) + '</code>',
                 *[pair(c[side][metric]) for metric in ('all', 'key') for side in ('AnySentry', 'AgentSight')],
                 escape(verdict(c)), escape(explanation(r))]
        if r.get('job', '').startswith('kimi-fix-single-r2-20261030'):
            assert c['AnySentry']['all'] == [72, 50]
            assert c['AnySentry']['key'] == [20, 21]
            assert c['AgentSight']['key'] == [21, 21]
            assert len(r['unconfirmed_key_events']) == 1
            assert r['unconfirmed_key_events'][0]['event_id'] == 'evt_a3e9c65251d49c7e'
            cells[4] = '20 已确认 + 1 未确认 / 21 exit'
            cells[6] = 'Git 记录数对齐；exec 确认状态不同'
        body.append('<tr>' + ''.join(f'<td>{v}</td>' for v in cells) + '</tr>')
    if aggregate:
        c = totals(items)
        cells = ['合计', '本表归档样本', *[pair(c[side][metric]) for metric in ('all', 'key') for side in ('AnySentry', 'AgentSight')],
                 escape(verdict(c)), '跨任务合计仅为所选记录数，不是完整内核覆盖率。']
        body.append('<tr>' + ''.join(f'<td>{v}</td>' for v in cells) + '</tr>')
    return '<table><thead><tr>' + ''.join(f'<th>{h}</th>' for h in HEADERS) + '</tr></thead><tbody>' + ''.join(body) + '</tbody></table>'


style = TARGET.read_text().split('<style>', 1)[1].split('</style>', 1)[0]
style += '\nsmall{display:block;color:#475569}td:nth-child(3),td:nth-child(4),td:nth-child(5),td:nth-child(6){white-space:nowrap;text-align:right}th{overflow-wrap:normal}\n'
html = ['<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
        '<title>AnySentry 与 AgentSight 实验结果（核对版）</title><style>' + style + '</style></head><body>',
        '<h1>AnySentry 与 AgentSight 的 Terminal-Bench 2.1 进程证据对照</h1>',
        '<p>实验执行：2026-10-27—10-30；数据复核：2026-10-30。单任务 fix-git 已更新为 10 月 30 日最新重跑，其余行保留各自实验轮次；不是当前部署版本的统一成绩。</p>',
        '<h2>1. 单任务与同题并发：关键程序记录对照</h2>',
        '<p>单任务、S1、S2 是不同执行轮次，不能将它们的原始数量直接作为并发或修复的因果对照。第 1、3 节使用产品数据库归档记录；第 4 节明确使用独立原始 Collector。两个数据层级不合并排名。</p>']
for group, title in [('单任务', '1.1 单任务样本'), ('S2-G', '1.2 S2-G：fix-git × 2'),
                     ('S2-P', '1.3 S2-P：polyglot-c-py × 4，三个有效样本'), ('S2-D', '1.4 S2-D：db-wal-recovery × 4')]:
    html += [f'<h3>{title}</h3>', table([r for r in rows if r['group'] == group], aggregate=group != '单任务')]
    if group == '单任务':
        html += ['<p><strong>fix-git 最新重跑三方核对：</strong>该轮 Git 记录均已保留。confirmed/unconfirmed 是 AnySentry 的执行确认状态，不能把未确认记录当成缺失，也不能仅凭合计相同声称未确认记录已获得成功 exec 证明。</p>',
                 '<table><thead><tr><th>数据源</th><th>confirmed Git exec</th><th>unconfirmed Git 记录</th><th>Git exec 记录合计</th><th>Git exit</th></tr></thead><tbody>',
                 '<tr><td>独立原始 Collector</td><td>20</td><td>1</td><td>21</td><td>21</td></tr>',
                 '<tr><td>AnySentry</td><td>20</td><td>1</td><td>21</td><td>21</td></tr>',
                 '<tr><td>AgentSight</td><td>21（自身口径）</td><td>不适用</td><td>21</td><td>21</td></tr></tbody></table>',
                 '<p>未确认记录：<code>git status --short --branch</code>，PID <code>676583</code>，事件 <code>evt_a3e9c65251d49c7e</code>，<code>argv_incomplete=true</code>、<code>exec_confirmed=false</code>，位于原窗口内。原始 Collector 的 dropped/output_dropped 均为 0，缺启动时间、代际冲突和创建父代际不匹配均为 0。总 exec 仍报告 AnySentry confirmed 72 条，不将未确认记录静默加进 confirmed。</p>',
                 '<p><a href="experiments/20261030-final-report/fix-single-r2-analysis.json">最新重跑分析原件</a>。10 月 27 日的旧异常样本另保留在<a href="experiments/20261030-single-vs-s1-review/review.json">历史复核</a>中，本次重跑不追溯消除旧轮次问题。</p>']
html += ['<p>S2-P 的 A 未完成，不计入；S2-D 的 B、C reward 为 1.0，A、D 为评分器超时，仍保留为观测样本。以上是关键记录数，不以 AnySentry 自身记录数定义无偏完整真值。</p>',
         '<h2>2. 实验设置与统一计数规则</h2>',
         '<ul><li>Harbor 调度 Kimi Code 执行 Terminal-Bench 2.1；两套系统观测同一次运行。不同轮次模型路径、负载及采集状态可能不同，未证明所有轮次的版本与配置完全等同。</li>',
         '<li>exec：程序成功加载，不等于工具调用数，也不等于命令最终成功；exit：进程最终退出。一个 PID 可以多次 exec，但只有一次最终 exit。</li>',
         '<li>AnySentry 全部 exec 列默认仅统计 exec_confirmed=true；未确认关键记录另行明示。unconfirmed 表示缺少该执行确认条件，不等于事件未采集，也不自动等于执行失败。AgentSight 没有完全对应的确认分类，不直接将两种确认数相减称为漏采数。</li>',
         '<li>fix-git：按实际可执行程序 basename=git 统计，包含绝对 git-core 路径及其辅助程序；不匹配 Bash 参数中的 Git 文本。</li>',
         '<li>数据库恢复：统计 xxd、cp、python3、sqlite3、file、stat、rm、mv、dd、base64、openssl 的实际程序执行；排除 --version/-V 探测，不把通用 Shell 包装重复计入。</li>',
         '<li>polyglot：统一统计 gcc、cc1、as、collect2、ld 及 /app/polyglot/cmain；包括实际执行过的编译失败与重试。不能仅以 cmain 数量代表全部关键程序。</li>',
         '<li>关键 exit 使用双方关键 exec 对应 PID 的并集选择，即允许“某系统有 exit、无 exec”。这是本轮短窗口对账，不是通用的跨轮裸 PID 归属算法。</li>',
         '<li>原生 Read/Edit/Write 不一定创建进程；文件、网络和模型内容须单独核验，不伪装成 exec/exit。官方评分证明任务通过，不证明内核事件采齐。</li>',
         '<li>表内全部记录与关键记录都采用对应轮次的归档窗口。最新单任务 fix-git 的未确认记录位于原窗口内；旧轮次扩大窗口补查另存历史复核，不混用两轮数值。</li></ul>',
         '<p><a href="experiments/20261030-final-report/recount.json">各轮运行标识、筛选规则与逐事件计数</a>；<a href="experiments/20261030-single-vs-s1-review/review.json">旧轮单任务 fix-git 迟到记录复核</a>。</p>',
         '<h2>3. 并发场景汇总</h2><h3>3.1 S1：异任务并发</h3>',
         '<p>轮次：s1-c24-recheck-20261028-110213；fix-git、db-wal-recovery、polyglot-c-py 三个容器并发，reward 均为 1.0。与第 1 节单任务不是同一轮；采用上文一致的任务程序筛选规则。</p>',
         table([r for r in rows if r['group'] == 'S1'], aggregate=True),
         '<h3>3.2 S2：同题并发汇总</h3>']
aggregate_rows = []
for group, task in [('S2-G', 'fix-git × 2'), ('S2-P', 'polyglot-c-py × 4，三个有效样本'), ('S2-D', 'db-wal-recovery × 4')]:
    items = [r for r in rows if r['group'] == group]
    aggregate_rows.append({'group': group, 'task': task, 'date': items[0]['date'], 'counts': totals(items), 'instance': '', 'aggregate': True})
html += [table(aggregate_rows), '<p>本节与第 1 节相同 S2 轮次的数字来自同一份计算结果，不另设统计口径。数量更多不自动证明关联更准确。</p>',
         '<h2>4. 三任务混合并发（S3 候选）：原始 Collector 对照</h2>',
         '<p>轮次：s3-mixed-20261028-213330。三个任务 reward 均为 1.0；Agent 执行约 163.0、248.6、59.7 秒，三路重叠约 59.7 秒。这是短时混合并发，不是 40 分钟长程验收。</p>',
         '<p>此处围绕部署/破解任务另选必要安装主命令、账户与权限、任务程序和结果验证。排除包管理器内部辅助、通用包装、Git 自动维护和临时清理。仍统一以实际 exec 与对应 PID 的 exit 计数；7z 的三个业务环节不再冒充三条内核事件。</p>']
s3 = json.loads((CODE / 'AnySentry/docs/experiments/20261030-s3-critical-recount/recount.json').read_text())
headers = ['任务', 'AnySentry 原始全部 exec / exit', 'AgentSight 全部 exec / exit', 'AnySentry 原始关键 exec / exit', 'AgentSight 关键 exec / exit', '记录对照', '说明']
total_values = {'configure-git-webserver': [[446, 447], [278, 264]], 'crack-7z-hash': [[95, 88], [66, 58]], 'polyglot-c-py': [[38, 37], [31, 28]]}
reasons = {
    'configure-git-webserver': 'AgentSight 缺少最终 nginx exec/exit，以及 git clone、git-upload-pack 的 exit。覆盖依赖主命令、账户权限、仓库部署、端口及 HTTP 验证。',
    'crack-7z-hash': '双方均有 2 条 apt-get、2 次 Perl 哈希提取（含失败后重试）、1 次 John、1 次实际 7z 解压、1 次 rg 定位结果，共 7 exec、7 exit。',
    'polyglot-c-py': '编译链 5 条 exec，加 7 次 cmain；双方 exec 对齐。AgentSight 缺少 gcc、collect2 的 exit。'}
body = []
for r in s3['tasks']:
    task = r['task']; ac = r['counts']['raw']; bc = r['counts']['AS']
    label = '所选关键记录持平' if ac == bc else 'AnySentry 原始所选关键记录更多'
    cells = [f'<code>{task}</code>', pair(total_values[task][0]), pair(total_values[task][1]), pair([ac['exec'], ac['exit']]), pair([bc['exec'], bc['exit']]), label, reasons[task]]
    body.append('<tr>' + ''.join(f'<td>{v}</td>' for v in cells) + '</tr>')
html += ['<table><thead><tr>' + ''.join(f'<th>{h}</th>' for h in headers) + '</tr></thead><tbody>' + ''.join(body) + '</tbody></table>',
         '<p>此表 AnySentry 为独立原始 Collector，不是产品入库成绩。本轮产品任务窗口没有 ToolExec；历史诊断包括 agent_allowlist 过滤、批次拒绝和 request aborted。原始对照记录不能替代产品入库结果。</p>',
         '<p>配置文件写入、秘密文件读取、solution.txt 与源码写入也是关键行为，但没有独立核对的文件内核证据时，只能标为原生工具日志证据，不能宣称由本表完整覆盖。<a href="experiments/20261030-s3-critical-recount/recount.json">S3 逐程序与 PID 筛选明细</a>。</p>',
         '</body></html>']

OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'fix-single-r2-analysis.json').write_text((EVAL / 'fix-single-r2-20261030-145744/analysis.json').read_text())
(OUT / 'recount.json').write_text(json.dumps({'reviewed_at': '2026-10-30', 'rules': {
    'fix-git': 'actual executable basename git, including git-core helpers',
    'db-wal-recovery': sorted(DB), 'exclude_db_args': ['--version', '-V'],
    'polyglot-c-py': sorted(COMPILER) + ['/app/polyglot/cmain'],
    'exit_scope': 'Union of both systems selected exec PIDs, within each archived window'}, 'rows': rows}, ensure_ascii=False, indent=2) + '\n')
TARGET.write_text(make_editable('\n'.join(html) + '\n'))
for group in ('单任务', 'S1', 'S2-G', 'S2-P', 'S2-D'):
    print(group, totals([r for r in rows if r['group'] == group]))
print(TARGET)
