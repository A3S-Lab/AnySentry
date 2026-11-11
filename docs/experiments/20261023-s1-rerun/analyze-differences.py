"""Read-only review of archived S1 events; PID alignment is local to this short run.
Run from any directory. Does not restart or modify either observer.
"""
import collections
import json
from pathlib import Path

ROOT = Path('/home/zhongyule/code/terminal-bench/eval/s1-rerun-20261023-165554')


def command(event):
    attrs = event.get('attrs', event.get('details', {}))
    value = attrs.get('argv') or attrs.get('full_command') or event.get('subject') or event.get('comm', '')
    return (' '.join(value) if isinstance(value, list) else str(value))[:300]


def review(task):
    data = json.loads((ROOT / f'{task}-evidence.json').read_text())
    ae = [e for e in data['AnySentry'] if e['kind'] == 'ToolExec' and e['attrs'].get('exec_confirmed') is True]
    se = [e for e in data['AgentSight'] if e['action'] == 'exec']
    ax = [e for e in data['AnySentry'] if e['kind'] == 'ProcessExit']
    sx = [e for e in data['AgentSight'] if e['action'] == 'exit']
    ac, sc = (collections.Counter(e['pid'] for e in es) for es in (ae, se))
    ap, sp = ({e['pid'] for e in es} for es in (ax, sx))
    return {
        'task': task,
        'exec': {
            'AnySentry': len(ae), 'AgentSight': len(se),
            'AnySentry_only_pid_count_surplus': sum((ac - sc).values()),
            'AgentSight_only_pid_count_surplus': sum((sc - ac).values()),
            'AnySentry_only': [{'pid': p, 'count': n, 'commands': [command(e) for e in ae if e['pid'] == p]} for p, n in (ac - sc).items()],
            'AgentSight_only': [{'pid': p, 'count': n, 'commands': [command(e) for e in se if e['pid'] == p]} for p, n in (sc - ac).items()],
        },
        'exit': {
            'AnySentry': len(ax), 'AgentSight': len(sx), 'shared_pid_count': len(ap & sp),
            'AnySentry_only': [{'pid': e['pid'], 'at_ms': e['event_at']} for e in ax if e['pid'] not in sp],
            'AgentSight_only': [{'pid': e['pid'], 'comm': e['comm'], 'at_ms': e['timestamp_ms'],
                                'exit_code': e['details'].get('exit_code'),
                                'AnySentry_has_exec': e['pid'] in ac}
                               for e in sx if e['pid'] not in ap],
        },
    }


if __name__ == '__main__':
    print(json.dumps({'alignment': 'Per-task PID/count comparison inside archived short execution windows; not a generation-safe universal matcher.',
                      'tasks': [review(t) for t in ['fix-git', 'db-wal-recovery', 'polyglot-c-py']]}, ensure_ascii=False, indent=2))
