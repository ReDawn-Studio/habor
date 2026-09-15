"""Replay structured errors through the real ZCode adapter and CLI in a POSIX TTY."""
import fcntl
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
import time

root = Path(__file__).resolve().parents[3]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 100, 0, 0))
captured = bytearray()


def read_until(expected, timeout=8, since=0):
    end = time.monotonic() + timeout
    while expected not in captured[since:] and time.monotonic() < end:
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            captured.extend(chunk)
    assert expected in captured[since:], f'Missing {expected!r}; process exit={proc.poll()}; terminal tail=' + re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', captured.decode('utf8', errors='replace'))[-900:]


with tempfile.TemporaryDirectory(prefix='habor-event-replay-') as work:
    state = Path(work, 'state')
    state.mkdir()
    (state / 'state.jsonl').write_text('')
    (state / 'trust.json').write_text(json.dumps({'version': 1, 'paths': [str(Path(work).resolve())]}))
    proc = subprocess.Popen(['node', str(root / 'packages/cli/dist/index.js')], cwd=work,
                            stdin=slave, stdout=slave, stderr=slave,
                            env={**os.environ, 'TERM': 'xterm-256color', 'HABOR_STATE_DIR': str(state),
                                 'ZCODE_CLI': str(root / 'packages/cli/test/fixtures/zcode-errors.cjs')})
    try:
        read_until('Ask your question'.encode())
        os.write(master, b'\x1bOQ')
        read_until('个模型 ·'.encode())
        os.write(master, b'\x1b[B\x1b[B\r')  # select GLM in the real startup picker
        read_until('已选择 GLM-5.3'.encode())
        os.write(master, b'fail\r')
        read_until(b'Upstream replay failure')
        read_until('回复出错'.encode())
        assert b'Tool replay failure' in captured
        assert proc.poll() is None, 'structured errors crashed the CLI'
        retry_offset = len(captured)
        os.write(master, b'retry\r')
        read_until(b'Recovery succeeded', since=retry_offset)
        read_until('已完成'.encode(), since=retry_offset)
        assert proc.poll() is None, 'next submission crashed the CLI'
        os.write(master, b'/quit\r')
        read_until(b'bye')
        assert proc.wait(timeout=3) == 0
        assert b'TypeError' not in captured and b'[object Object]' not in captured
        assert b'\x1b[?1049l' in captured
        print('Event replay passed: object errors → actual adapter → router → TUI → next prompt → clean exit')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        os.close(slave)
