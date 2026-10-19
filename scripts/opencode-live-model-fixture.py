"""Deterministic loopback-only OpenAI-compatible model for real OpenCode CLI tests.

Never uses external model credentials. Tools only run the fixed commands below.
Usage: python3 scripts/opencode-live-model-fixture.py --port 29868
"""
import argparse
import json
import re
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    gate = threading.Condition()
    parallel = {}
    def log_message(self, *_args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = data.get('messages', [])
        index = max((i for i, m in enumerate(messages) if m.get('role') == 'user'), default=0)
        prompt = json.dumps(messages[index] if messages else {})
        marker = re.search(r'ANYSENTRY_OPENCODE_[A-Z0-9_]+', prompt)
        marker = marker.group(0) if marker else 'ANYSENTRY_OPENCODE_TITLE'
        names = [tool.get('function', {}).get('name') for tool in data.get('tools', [])]
        answered = any(message.get('role') == 'tool' for message in messages[index + 1:])
        tool = 'bash' in names and not answered
        if tool and 'PARALLEL_' in marker:
            key = marker.rsplit('_', 1)[-1]
            with self.gate:
                self.parallel.setdefault(key, set()).add(marker)
                self.gate.notify_all()
                self.gate.wait_for(lambda: len(self.parallel[key]) == 2, timeout=25)
        command = f"/usr/bin/printf '%s\\n' '{marker}'; /usr/bin/sleep 2"
        if 'FAIL' in marker:
            command += '; /usr/bin/false'
        delta = {'content': f'Completed {marker}.'}
        if tool:
            delta = {'tool_calls': [{'index': 0, 'id': 'call_' + marker, 'type': 'function', 'function': {
                'name': 'bash', 'arguments': json.dumps({'command': command, 'description': marker})}}]}
        finish = 'tool_calls' if tool else 'stop'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if data.get('stream') else 'application/json')
        self.end_headers()
        try:
            if data.get('stream'):
                for value, reason in [({'role': 'assistant'}, None), (delta, None), ({}, finish)]:
                    chunk = {'id': 'fixture_' + marker, 'object': 'chat.completion.chunk', 'created': int(time.time()),
                             'model': 'local-fixture', 'choices': [{'index': 0, 'delta': value, 'finish_reason': reason}]}
                    self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                    self.wfile.flush()
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                self.wfile.write(json.dumps({'id': 'fixture_' + marker, 'object': 'chat.completion', 'model': 'local-fixture',
                    'choices': [{'index': 0, 'message': {'role': 'assistant', **delta}, 'finish_reason': finish}],
                    'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}).encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        print(json.dumps({'marker': marker, 'tool_request': tool}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=29868)
    args = parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
