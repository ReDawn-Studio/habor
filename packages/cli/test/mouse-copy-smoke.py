"""Real PTY: drag output, inspect OSC 52 clipboard payload, scroll and restore terminal modes.

No model is started. SSH mode records clipboard writes without changing the tester's clipboard.
"""
import base64
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
captured = bytearray()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))


def wait_for(pattern, since=0, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        match = re.search(pattern, captured[since:])
        if match:
            return match
        if select.select([master], [], [], 0.05)[0]:
            captured.extend(os.read(master, 65536))
    raise AssertionError(f'Missing output {pattern!r}')


with tempfile.TemporaryDirectory(prefix='habor-mouse-copy-') as work:
    script = Path(work, 'fixture.mjs')
    script.write_text('import { TuiController } from ' + json.dumps((root / 'packages/cli/dist/tui/index.js').as_uri()) + ''';
const tui = new TuiController({version:'mouse-test',onInput(){},onExit(){tui.stop();console.log('copy-test-exit');process.exit(0)}});
tui.start();
tui.view.append({kind:'assistant',text:'可复制你好 world'});
''')
    proc = subprocess.Popen(['node', str(script)], stdin=slave, stdout=slave, stderr=slave,
                            env={**os.environ, 'TERM': 'xterm-256color', 'HABOR_MOUSE_SCROLL': '1', 'SSH_CONNECTION': 'clipboard-test'})
    try:
        wait_for('可复制你好'.encode())
        assert b'\x1b[?1002h' in captured
        offset = len(captured)
        # Text starts at column 5, row 4 (one-based), after the assistant marker.
        os.write(master, b'\x1b[<0;5;4M\x1b[<32;14;4M\x1b[<0;14;4m')
        copied = wait_for(rb'\x1b\]52;c;([A-Za-z0-9+/=]+)\x1b\\', offset)
        assert base64.b64decode(copied.group(1)).decode() == '可复制你好'
        assert b'48;2;165;189;247' in captured[offset:], 'Selection was not highlighted'
        offset = len(captured)
        os.write(master, b'\x03')
        copied = wait_for(rb'\x1b\]52;c;([A-Za-z0-9+/=]+)\x1b\\', offset)
        assert base64.b64decode(copied.group(1)).decode() == '可复制你好'
        assert proc.poll() is None, 'Copy cancelled/exited the TUI'
        os.write(master, b'\x1b')  # Clear the selection.
        time.sleep(0.1)
        os.write(master, b'\x1b[<64;8;6M\x1b[<65;8;6M')  # Wheel remains an app event.
        os.write(master, b'\x03\x03')
        wait_for(b'copy-test-exit')
        assert proc.wait(timeout=3) == 0
        assert b'\x1b[?1002l' in captured and b'\x1b[?1049l' in captured
        assert termios.tcgetattr(slave)[3] & termios.ICANON
        print('Mouse-copy PTY passed: drag highlight, Chinese clipboard payload, Ctrl+C copy, wheel handling and terminal restoration.')
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        os.close(slave)
