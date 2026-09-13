"""Actual TTY wizard -> CLI -> router -> native DSH -> private HTTP server.

Uses isolated state and synthetic keys. No personal account or external model requests.
"""
import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import threading
import time

root = Path(__file__).resolve().parents[3]
requests = []
local_key, first_key, next_key = 'pty-local-key', 'pty-provider-key', 'pty-updated-key'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'model': body.get('model'), 'auth': self.headers.get('Authorization'), 'body': body})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for delta, finish in [({'role': 'assistant', 'content': 'PTY provider OK'}, None), ({}, 'stop')]:
            chunk = {'id': 'test', 'object': 'chat.completion.chunk', 'created': 1, 'model': body.get('model'),
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/v1'


class Terminal:
    def __init__(self, work, state, dsh):
        self.state = state
        self.diagnostics = Path(work, 'native-stderr.log')
        tracer = Path(work, 'trace-native.mjs')
        tracer.write_text("""import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
const spawn=cp.spawn;
cp.spawn=(...args)=>{const child=spawn(...args);if(args[1]?.some(arg=>arg.includes('/dsh-acp/')))child.stderr?.on('data',data=>appendFileSync(process.env.HABOR_TEST_TRACE,data,{mode:0o600}));return child;};
syncBuiltinESMExports();
""")
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 34, 120, 0, 0))
        self.output = bytearray()
        self.proc = subprocess.Popen(['node', str(root / 'packages/cli/dist/index.js')], cwd=work,
                                     stdin=self.slave, stdout=self.slave, stderr=self.slave,
                                     env={**os.environ, 'TERM': 'xterm-256color', 'HABOR_STATE_DIR': str(state), 'DSH_HOME': str(dsh),
                                          'NODE_OPTIONS': '--import=' + str(tracer), 'HABOR_TEST_TRACE': str(self.diagnostics)})

    def send(self, value):
        os.write(self.master, value.encode())

    def paste(self, value):
        self.send('\x1b[200~' + value + '\x1b[201~')

    def wait_condition(self, predicate, timeout=15):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if select.select([self.master], [], [], 0.05)[0]:
                self.output.extend(os.read(self.master, 65536))
            if predicate():
                return
        raise AssertionError('Timed out waiting for saved task/connection state')

    def tasks(self):
        return [json.loads(line) for line in (self.state / 'state.jsonl').read_text().splitlines() if line]

    def wait(self, text, since=0, timeout=15):
        end = time.monotonic() + timeout
        while text.encode() not in self.output[since:] and time.monotonic() < end:
            if select.select([self.master], [], [], 0.1)[0]:
                try:
                    self.output.extend(os.read(self.master, 65536))
                except OSError:
                    break
        tail = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', self.output.decode('utf8', errors='replace'))[-1600:]
        if text.encode() not in self.output[since:] and self.diagnostics.exists():
            tail += '\nNative diagnostics: ' + self.diagnostics.read_text()[-2000:]
        for key in [local_key, first_key, next_key]:
            tail = tail.replace(key, '[redacted]')
        assert text.encode() in self.output[since:], f'Missing {text!r}; exit={self.proc.poll()}; tail={tail}'

    def prompt(self, value):
        offset, count = len(self.output), len(requests)
        before = sum(len(task['conversation']) for task in self.tasks())
        if value:
            self.paste(value)
        self.send('\r')
        self.wait_condition(lambda: sum(len(task['conversation']) for task in self.tasks()) >= before + 2)
        self.wait('PTY provider OK', since=offset)
        self.wait('已完成', since=offset)
        return requests[count:]

    def add_provider(self, name, only_save=False):
        self.send('\x1bOR')  # F3
        self.wait('连接与提供商')
        self.send('\x1b[B\x1b[B\r')
        for value in [name, url, first_key, 'deepseek-flash']:
            self.paste(value)
            self.send('\r')
        self.send('\r')  # accept inferred DSH agent
        self.wait('保存并使用')
        if only_save:
            self.send('\x1b[B')
        offset = len(self.output)
        self.send('\r')
        self.wait('当前连接：' if only_save else '已切换到 deepseek-flash', since=offset)
        self.wait_condition(lambda: any(p['name'] == name for p in json.loads((self.state / 'providers.json').read_text())['providers']))
        if not only_save:
            self.wait_condition(lambda: any(t['bindings'][-1]['model'] == 'deepseek-flash · ' + name for t in self.tasks()))

    def quit(self):
        self.send('/quit\r')
        self.wait('bye')
        assert self.proc.wait(timeout=5) == 0
        for key in [local_key, first_key, next_key]:
            assert key.encode() not in self.output, 'Key leaked to the terminal'

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        os.close(self.master)
        os.close(self.slave)


try:
    with tempfile.TemporaryDirectory(prefix='habor-activation-') as work:
        state, dsh = Path(work, 'state'), Path(work, 'dsh')
        state.mkdir()
        dsh.mkdir()
        (state / 'state.jsonl').write_text('')
        (dsh / 'settings.yaml').write_text(json.dumps({
            'agent-default-model': {'provider': 'deepseek', 'model': 'deepseek-v4-flash'},
            'llm-pi-ai': {'providers': {'deepseek': {'baseURL': url, 'apiKeyEnv': 'HABOR_TEST_LOCAL',
                'api': 'openai-completions', 'models': [{'id': 'deepseek-v4-flash'}]}}}}))
        (dsh / '.credentials.yaml').write_text(f'HABOR_TEST_LOCAL: {local_key}\n')
        os.chmod(dsh / 'settings.yaml', 0o600)
        os.chmod(dsh / '.credentials.yaml', 0o600)
        terminal = Terminal(work, state, dsh)
        try:
            terminal.wait('个模型 ·')
            terminal.send('\r')
            terminal.wait('已选择 DeepSeek V4 Flash')
            terminal.prompt('remember continuity 73 without tools')
            terminal.paste('continue draft without tools')
            count = len(requests)
            terminal.add_provider('PTY gateway')
            assert len(requests) == count, 'Saving sent the draft without confirmation'
            sent = terminal.prompt('')
            matched = [r for r in sent if r['model'] == 'deepseek-flash' and r['auth'] == f'Bearer {first_key}']
            assert matched, 'New provider Key/model was not activated'
            assert any('continuity 73' in json.dumps(r['body']) and 'continue draft' in json.dumps(r['body']) for r in matched)

            # Change the active provider Key without changing the model label.
            terminal.send('\x1bOR\x1b[A\r\x1b[B\x1b[B')
            terminal.paste(next_key)
            offset = len(terminal.output)
            terminal.send('\r\r\r\r')
            terminal.wait('已切换到 deepseek-flash', since=offset)
            terminal.wait_condition(lambda: next_key in json.loads((state / 'credentials.json').read_text()).values())
            # The same label is repainted while availability is refreshing; wait for the panel to finish applying.
            time.sleep(0.5)
            sent = terminal.prompt('use updated key without tools')
            assert any(r['auth'] == f'Bearer {next_key}' for r in sent), 'Native session retained the old Key'

            terminal.add_provider('Spare gateway', only_save=True)
            sent = terminal.prompt('keep current source without tools')
            assert sent and all(r['auth'] == f'Bearer {next_key}' for r in sent), 'Save-only changed the active source'
            terminal.quit()
        finally:
            terminal.close()
        tasks = [json.loads(line) for line in (state / 'state.jsonl').read_text().splitlines() if line]
        assert len(tasks) == 1, 'Saving a provider discarded the current task'
        assert len(tasks[0]['bindings']) == 2
        assert tasks[0]['bindings'][-1]['model'] == 'deepseek-flash · PTY gateway'
        for path in [state / 'state.jsonl', state / 'providers.json', state / 'selection.json']:
            assert all(key not in path.read_text() for key in [local_key, first_key, next_key])
        terminal = Terminal(work, state, dsh)
        try:
            terminal.wait('已选择 deepseek-flash · PTY gateway')
            sent = terminal.prompt('verify restored source without tools')
            assert sent and all(r['auth'] == f'Bearer {next_key}' and r['model'] == 'deepseek-flash' for r in sent)
            terminal.quit()
        finally:
            terminal.close()
        print('Provider activation passed: TTY save-and-use, native HTTP credentials/model, task/draft continuity, Key refresh, save-only, restart and secret isolation')
finally:
    server.shutdown()
    server.server_close()
