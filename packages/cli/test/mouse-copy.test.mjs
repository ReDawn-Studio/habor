import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AppView, THEME } from '../dist/tui/app.js';
import { decodeKey, Terminal } from '../dist/tui/vendor/term.js';
import { TranscriptSelection } from '../dist/tui/transcript-selection.js';
import { writeClipboard } from '../dist/tui/clipboard.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const copies = [], actions = [];
  const terminal = { cols: 80, rows: 24, paint(screen) { this.screen = screen; }, async copyToClipboard(text) { copies.push(text); return true; } };
  const view = new AppView({ terminal, version: 'test', onInput() {}, onCancelInput() { actions.push('cancel'); }, onExit() { actions.push('exit'); } });
  const mouse = (button, x, y, release = false) => view.handleKey(decodeKey(Buffer.from(`\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`)).key);
  const position = ch => { for (let y = 3; y < 18; y++) { const x = terminal.screen.cells[y].findIndex(cell => cell.ch === ch); if (x >= 0) return { x, y }; } throw new Error(`Missing ${ch}`); };
  const screenText = () => terminal.screen.cells.map(row => row.map(cell => cell.ch).join('')).join('\n');
  view.paint();
  return { view, terminal, mouse, position, copies, actions, screenText };
}

test('decoded SGR dragging highlights complete Chinese/emoji graphemes and release copies without a shortcut', async () => {
  const { view, terminal, mouse, position, copies } = setup();
  view.append({ kind: 'assistant', text: '你好👨‍👩‍👧‍👦é test' });
  view.setInput('keep this draft');
  const { x, y } = position('你');
  mouse(0, x + 1, y); // Start on the continuation cell of 你.
  mouse(32, x + 6, y); // End at combining é.
  assert.equal(terminal.screen.cells[y][x].style.bg, THEME.accent);
  assert.equal(terminal.screen.cells[y][x + 1].style.bg, THEME.accent);
  assert.equal(terminal.screen.cells[y][x + 6].style.bg, THEME.accent);
  mouse(0, x + 6, y, true);
  await settle();
  assert.deepEqual(copies, ['你好👨‍👩‍👧‍👦é']);
  assert.equal(view.input, 'keep this draft');
  assert.equal(terminal.screen.cells[0][x].style.bg, THEME.background);
});

test('reverse multiline selection keeps code indentation and never splits wide characters', () => {
  const selection = new TranscriptSelection(['    alpha', '    你好👋', '    omega'], 20, { row: 2, col: 8 });
  selection.extend({ row: 0, col: 0 });
  assert.equal(selection.text(), '    alpha\n    你好👋\n    omega');
  const click = new TranscriptSelection(['one'], 20, { row: 0, col: 0 });
  assert.equal(click.text(), '');
});

test('a streaming selection remains stable; Ctrl+C/right-click copy it and Esc clears it before stopping', async () => {
  const { view, mouse, position, copies, actions, screenText } = setup();
  view.append({ kind: 'assistant', text: 'Answer before' });
  view.setBusy(true);
  const { x, y } = position('A');
  mouse(0, x, y); mouse(32, x + 5, y); mouse(0, x + 5, y, true);
  await settle();
  view.append({ kind: 'assistant', text: '', meta: { delta: ' plus new output' } });
  view.tick();
  assert.doesNotMatch(screenText(), /plus new output/);
  view.handleKey({ name: 'c', ctrl: true }); mouse(2, x, y);
  await settle();
  assert.deepEqual(copies, ['Answer', 'Answer', 'Answer']);
  assert.deepEqual(actions, []);
  view.handleKey({ name: 'escape' });
  assert.match(screenText(), /plus new output/);
  assert.deepEqual(actions, []);
  view.handleKey({ name: 'escape' });
  assert.deepEqual(actions, ['cancel']);
});

test('wheel and edge dragging scroll only the transcript and leave the composer in place', async () => {
  const { view, terminal, mouse, copies } = setup();
  view.append({ kind: 'assistant', text: Array.from({ length: 90 }, (_, i) => `Line ${i}`).join('\n\n') });
  view.setInput('unfinished draft');
  const cursorY = terminal.screen.cursorY;
  const end = view.scroll;
  mouse(64, 8, 5);
  assert.equal(view.scroll, end - 3);
  const start = view.scroll;
  mouse(0, 4, 4); mouse(32, 20, 2); view.tick(); mouse(0, 20, 2, true);
  await settle();
  assert.ok(view.scroll < start);
  assert.equal(copies.length, 1);
  assert.doesNotMatch(copies[0], /habor|unfinished draft|F2/);
  assert.equal(terminal.screen.cursorY, cursorY);
  assert.equal(view.input, 'unfinished draft');
});

test('clicking, resizing, switching conversations and opening key forms cannot copy stale content', async () => {
  const { view, terminal, mouse, position, copies } = setup();
  view.append({ kind: 'assistant', text: 'Visible answer' });
  let { x, y } = position('V');
  mouse(0, x, y); mouse(0, x, y, true);
  await settle(); assert.deepEqual(copies, []);
  mouse(0, x, y); mouse(32, x + 6, y);
  terminal.cols = 55; view.paint(); mouse(0, x + 6, y, true);
  await settle(); assert.deepEqual(copies, []);
  ({ x, y } = position('V'));
  mouse(0, x, y); mouse(32, x + 6, y);
  view.setConversation([{ role: 'assistant', text: 'Different task' }]);
  mouse(0, x + 6, y, true); await settle(); assert.deepEqual(copies, []);
  ({ x, y } = position('D'));
  mouse(0, x, y); mouse(32, x + 6, y);
  view.openProviders(); mouse(0, x + 6, y, true);
  mouse(0, x, y); mouse(32, x + 6, y); mouse(0, x + 6, y, true);
  await settle(); assert.deepEqual(copies, []);
});

test('Ctrl+Y writes the latest reply and a failed clipboard operation is not reported as success', async () => {
  const { view, terminal, copies, screenText } = setup();
  view.append({ kind: 'assistant', text: 'Full reply' });
  view.handleKey({ name: 'y', ctrl: true }); await settle();
  assert.deepEqual(copies, ['Full reply']);
  terminal.copyToClipboard = async () => false;
  view.handleKey({ name: 'y', ctrl: true }); await settle();
  assert.match(screenText(), /复制失败/);
});

function mockProcesses(fail = false) {
  const calls = [];
  const spawnProcess = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const call = { command, args, opts, input: '' }; calls.push(call);
    child.stdin.on('data', data => { call.input += data.toString('utf8'); });
    child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', fail ? 1 : 0)));
    child.kill = () => child.emit('close', 1);
    return child;
  };
  return { calls, spawnProcess };
}

test('macOS uses pbcopy stdin, Windows uses fixed PowerShell, and SSH uses UTF-8 OSC 52', async () => {
  const value = '你好👋\n$(touch NEVER) `literal`';
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { calls, spawnProcess } = mockProcesses();
    const writes = [];
    assert.equal(await writeClipboard(value, { platform, env: {}, spawnProcess, write: seq => writes.push(seq) }), true);
    assert.equal(calls[0].command, { darwin: 'pbcopy', win32: 'powershell.exe', linux: 'wl-copy' }[platform]);
    assert.equal(calls[0].input, platform === 'win32' ? Buffer.from(value).toString('base64') : value);
    assert.ok(calls[0].args.every(arg => !arg.includes(value)));
    assert.equal(calls[0].opts.shell, undefined);
    assert.deepEqual(writes, []);
  }
  const { calls, spawnProcess } = mockProcesses();
  const writes = [];
  assert.equal(await writeClipboard(value, { platform: 'darwin', env: { SSH_CONNECTION: 'test' }, spawnProcess, write: seq => writes.push(seq) }), true);
  assert.equal(calls.length, 0);
  assert.equal(writes[0], `\x1b]52;c;${Buffer.from(value).toString('base64')}\x1b\\`);
});

test('unavailable clipboard utilities fall back to OSC 52 and report output failures', async () => {
  const { spawnProcess } = mockProcesses(true);
  let output;
  assert.equal(await writeClipboard('copied', { platform: 'darwin', env: {}, spawnProcess, write: seq => { output = seq; } }), true);
  assert.match(output, /52;c;/);
  assert.equal(await writeClipboard('copied', { platform: 'darwin', env: {}, spawnProcess, write() { throw new Error('closed'); } }), false);
});

test('terminal enables drag reporting and restores all mouse modes after stop and native handoff', () => {
  const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
  let output = '';
  const target = { columns: 80, rows: 24, write(text) { output += text; }, on() {}, off() {} };
  const old = process.env.HABOR_MOUSE_SCROLL; delete process.env.HABOR_MOUSE_SCROLL;
  try {
    const term = new Terminal({ input, output: target });
    term.start(); assert.match(output, /\?1002h/); assert.match(output, /\?1006h/);
    term.stop(); assert.match(output, /\?1002l/); assert.ok(output.endsWith('\x1b[?1049l'));
    output = ''; term.start(); assert.match(output, /\?1002h/); term.stop();
    output = ''; process.env.HABOR_MOUSE_SCROLL = '0'; term.start(); assert.doesNotMatch(output, /\?1002h/); term.stop();
    assert.doesNotMatch(output, /\x1b\[3J/);
  } finally { if (old === undefined) delete process.env.HABOR_MOUSE_SCROLL; else process.env.HABOR_MOUSE_SCROLL = old; }
});
