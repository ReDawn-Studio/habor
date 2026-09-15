import test from 'node:test';
import assert from 'node:assert/strict';
import { AppView } from '../dist/tui/app.js';
import { InputEditor } from '../dist/tui/editor.js';
import { TurnEvents } from '../dist/tui/events.js';
import { Terminal, decodeKey, Screen } from '../dist/tui/vendor/term.js';
import { displayWidth, graphemes } from '../dist/tui/vendor/util.js';
import { renderMarkdown } from '../dist/tui/vendor/markdown.js';
import { THEME } from '../dist/tui/app.js';

function setup(options = {}, cols = 80, rows = 24) {
  const terminal = { cols, rows, paint(screen) { this.screen = screen; } };
  const sent = [];
  const view = new AppView({ terminal, version: '0.2.0', cwd: '/work/habor', onInput: text => { sent.push(text); }, ...options });
  const text = () => terminal.screen.cells.map(row => row.map(c => c.ch).join('')).join('\n');
  view.paint();
  return { terminal, view, sent, text };
}
const type = (view, text) => { for (const ch of text) view.handleKey({ name: ch, text: ch }); };

test('CJK, combining characters and emoji can be edited without splitting graphemes', () => {
  const editor = new InputEditor();
  editor.insert('你好👨‍👩‍👧‍👦é');
  editor.backspace();
  assert.equal(editor.text, '你好👨‍👩‍👧‍👦');
  editor.left(); editor.insert('A'); editor.delete();
  assert.equal(editor.text, '你好A');
  assert.equal(displayWidth('👨‍👩‍👧‍👦é你好'), 7);
  assert.deepEqual(graphemes('é'), ['é']);
  const screen = new Screen(12, 1);
  assert.equal(screen.text(0, 0, '你好👨‍👩‍👧‍👦é'), 7);
  assert.equal(screen.cells[0][6].ch, 'é');
});

test('input cursor edits the middle and history restores an unfinished draft', async () => {
  const { view, sent } = setup();
  type(view, 'ac'); view.handleKey({ name: 'left' }); type(view, 'b');
  assert.equal(view.input, 'abc');
  view.handleKey({ name: 'return' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['abc']);
  type(view, 'draft'); view.handleKey({ name: 'up' });
  assert.equal(view.input, 'abc');
  view.handleKey({ name: 'down' }); assert.equal(view.input, 'draft');
});

test('multiline paste is one editable draft and never auto-submits', () => {
  const { view, sent, terminal } = setup();
  view.handleKey({ name: 'paste', data: Buffer.from('第一行\r\n第二行\t👋') });
  assert.equal(view.input, '第一行\n第二行  👋');
  assert.deepEqual(sent, []);
  view.handleKey({ name: 'enter', shift: true });
  type(view, '第三行');
  assert.equal(view.input, '第一行\n第二行  👋\n第三行');
  assert.ok(terminal.screen.cursorY < terminal.rows - 2);
});

test('slash menu updates while typing and arrow selection submits the chosen item', async () => {
  const { view, sent, text } = setup({ onComplete: input => ['/model', '/help'].filter(s => s.startsWith(input)) });
  type(view, '/');
  assert.match(text(), /选择或切换模型/);
  view.handleKey({ name: 'down' }); view.handleKey({ name: 'return' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['/help']);
});

test('model picker opens from /model and selects with arrows and Enter, without a model name', async () => {
  const { view, sent, text } = setup();
  view.setModels(['DeepSeek V4 Flash', 'Claude Sonnet 4.6', 'GPT-5.5']);
  view.setInput('/model'); view.handleKey({ name: 'return' });
  assert.ok(view.modelPicker);
  assert.match(text(), /选择模型/);
  assert.equal(view.input, '');
  view.handleKey({ name: 'down' }); view.handleKey({ name: 'return' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['/model Claude Sonnet 4.6']);
  assert.equal(view.modelPicker, null);
});

test('F2 focuses the current model and preserves the draft and caret on cancel or selection', async () => {
  const chosen = [];
  const { view } = setup({ onSelectModel: model => chosen.push(model) });
  view.setModels(['First', 'Second', 'Third']); view.setModel('Second');
  view.setInput('unfinished draft'); view.handleKey({ name: 'left' });
  const cursor = view.editor.cursor;
  view.handleKey({ name: 'f2' }); assert.equal(view.modelPicker.index, 1);
  view.handleKey({ name: 'up' }); view.handleKey({ name: 'escape' });
  assert.equal(view.input, 'unfinished draft'); assert.equal(view.editor.cursor, cursor);
  view.handleKey({ name: 'f2' }); view.handleKey({ name: 'down' }); view.handleKey({ name: 'return' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(chosen, ['Third']); assert.equal(view.input, 'unfinished draft');
  assert.equal(view.editor.cursor, cursor);
});

test('picker filtering is optional and empty matches never submit arbitrary text', async () => {
  const { view, sent, text } = setup();
  view.setModels(['Claude Sonnet', 'GPT']); view.openModels();
  type(view, 'zz'); view.handleKey({ name: 'return' });
  assert.deepEqual(sent, []); assert.match(text(), /没有匹配模型/);
  view.handleKey({ name: 'u', ctrl: true }); type(view, 'g');
  view.handleKey({ name: 'return' }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['/model GPT']);
});

test('model selection is serialized and a failed switch leaves the picker available for retry', async () => {
  let fail, attempts = 0;
  const { view, text } = setup({ onSelectModel: () => { attempts++; return new Promise((_, reject) => { fail = reject; }); } });
  view.setModels(['Test model']); view.openModels();
  view.handleKey({ name: 'return' }); view.handleKey({ name: 'return' });
  assert.equal(attempts, 1); assert.match(text(), /正在切换模型/);
  fail(new Error('connection failed')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.modelPicker.connecting, false); assert.match(text(), /connection failed/);
  view.handleKey({ name: 'escape' }); assert.equal(view.modelPicker, null);
});

test('picker supports /models, current-model no-op, unavailable models and terminal F2 sequences', async () => {
  const { view, sent, text } = setup();
  view.setInput('/models'); view.handleKey({ name: 'return' });
  assert.match(text(), /暂无可用模型/);
  view.handleKey({ name: 'return' }); assert.deepEqual(sent, []);
  view.setModels(['Active']); view.setModel('Active');
  view.handleKey({ name: 'return' }); assert.equal(view.modelPicker, null);
  assert.deepEqual(sent, []);
  assert.equal(decodeKey(Buffer.from('\x1bOQ')).key.name, 'f2');
  assert.equal(decodeKey(Buffer.from('\x1b[12~')).key.name, 'f2');
});

test('async submission stays serialized, preserves a draft and cancels without exit', async () => {
  let finish, cancelled = 0, exited = 0;
  const sent = [];
  const { view } = setup({
    onInput: text => { sent.push(text); return new Promise(resolve => { finish = resolve; }); },
    onCancelInput: () => cancelled++, onExit: () => exited++
  });
  type(view, 'first'); view.handleKey({ name: 'return' });
  type(view, 'next'); view.handleKey({ name: 'return' });
  assert.deepEqual(sent, ['first']); assert.equal(view.input, 'next');
  view.handleKey({ name: 'escape' });
  assert.equal(cancelled, 1); assert.equal(exited, 0);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.status, 'idle'); assert.equal(view.input, 'next');
});

test('scroll uses rendered lines and remains anchored as streaming output grows', () => {
  const { view, terminal } = setup();
  view.append({ kind: 'assistant', text: Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n\n') });
  const end = view.scroll; assert.ok(end > 30);
  view.handleKey({ name: 'pageup' }); const before = view.scroll;
  assert.ok(before < end); assert.equal(view.atBottom, false);
  view.append({ kind: 'assistant', text: 'new line', meta: { delta: '\n\nnew line' } });
  assert.equal(view.scroll, before);
  view.handleKey({ name: 'escape' }); assert.equal(view.atBottom, true);
  terminal.cols = 38; terminal.rows = 16; view.paint();
  assert.equal(terminal.screen.cols, 38);
  assert.ok(terminal.screen.cursorY >= 0 && terminal.screen.cursorY < 16);
});

test('stream projection preserves order, matches parallel tools and avoids cumulative duplicates', () => {
  const { view, text } = setup();
  const stream = new TurnEvents(view);
  stream.accept({ type: 'message', delta: 'Before' });
  stream.accept({ type: 'thinking', thinking: 'check this' });
  stream.accept({ type: 'thinking', thinking: ' and that' });
  stream.accept({ type: 'tool_call', tool: { id: 'a', name: 'Read', input: { path: 'a.ts' } } });
  stream.accept({ type: 'tool_call', tool: { id: 'b', name: 'Read', input: { path: 'b.ts' } } });
  stream.accept({ type: 'tool_result', toolResult: { id: 'a', output: 'partial', status: 'running' } });
  assert.equal(view.blocks.find(b => b.meta?.id === 'a').meta.status, 'running');
  stream.accept({ type: 'tool_result', toolResult: { id: 'a', output: 'A output' } });
  stream.accept({ type: 'tool_result', toolResult: { id: 'a', output: '', status: 'done' } });
  stream.accept({ type: 'tool_result', toolResult: { id: 'b', output: 'B failure', isError: true } });
  stream.accept({ type: 'message', delta: 'After' });
  stream.accept({ type: 'message', text: 'BeforeAfter' });
  assert.deepEqual(view.blocks.filter(b => b.kind === 'assistant').map(b => b.text), ['Before', 'After']);
  assert.equal(view.blocks.find(b => b.meta?.id === 'a').text, 'A output');
  assert.equal(view.blocks.find(b => b.meta?.id === 'b').meta.status, 'error');
  assert.doesNotMatch(text(), /check this/);
  view.handleKey({ name: 'o', ctrl: true }); assert.match(text(), /check this and that/);
});

test('markdown wrapping preserves code indentation, wide text and headings at narrow widths', () => {
  for (const width of [1, 8, 24, 76]) {
    const lines = renderMarkdown('# 标题'.repeat(12) + '\n```ts\n    const result = "你好👋";\n```', THEME, width);
    for (const row of lines) assert.ok(displayWidth(row.map(s => s.text).join('')) <= width, `overflow at width ${width}`);
  }
  const code = renderMarkdown('```ts\n    ok()\n```', THEME, 80).map(row => row.map(s => s.text).join('')).join('\n');
  assert.match(code, /    ok\(\)/);
});

test('fragmented terminal input handles UTF-8, CSI, paste and standalone Escape', async () => {
  assert.equal(decodeKey(Buffer.from('\x1b[1;')), null);
  assert.equal(decodeKey(Buffer.from('\x1b[1;2A')).key.shift, true);
  const terminal = new Terminal({ input: {}, output: { write() {} } });
  const keys = []; terminal.on('key', key => keys.push(key));
  terminal._handleData(Buffer.from('\x1b'));
  terminal._handleData(Buffer.from('[D'));
  const utf8 = Buffer.from('你'); terminal._handleData(utf8.subarray(0, 1)); terminal._handleData(utf8.subarray(1));
  terminal._handleData(Buffer.from('\x1b[200~a\nb'));
  terminal._handleData(Buffer.from('\x1b[201~'));
  terminal._handleData(Buffer.from('\x1b'));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(keys.map(k => k.name), ['left', '你', 'paste', 'escape']);
  assert.equal(keys[2].data.toString(), 'a\nb');
});

test('a stopped terminal cannot redraw over the restored shell', () => {
  let output = '';
  const input = { isTTY: true, setRawMode(value) { this.raw = value; }, resume() {}, pause() {}, on() {}, off() {} };
  const target = { columns: 80, rows: 24, write(text) { output += text; }, on() {}, off() {} };
  const terminal = new Terminal({ input, output: target });
  terminal.start(); terminal.paint(new Screen(80, 24)); terminal.stop();
  const restored = output;
  terminal.paint(new Screen(80, 24));
  assert.equal(input.raw, false);
  assert.equal(output, restored);
  assert.ok(output.endsWith('\x1b[?1049l'));
});

test('mouse reporting is opt-in so the terminal keeps native drag selection and copy', () => {
  let output = '';
  const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
  const target = { columns: 80, rows: 24, write(text) { output += text; }, on() {}, off() {} };
  const previous = process.env.HABOR_MOUSE_SCROLL;
  delete process.env.HABOR_MOUSE_SCROLL;
  try {
    const terminal = new Terminal({ input, output: target }); terminal.start();
    assert.doesNotMatch(output, /\?1000h|\?1006h/); terminal.stop();
    output = '';
    process.env.HABOR_MOUSE_SCROLL = '1';
    const scrolling = new Terminal({ input, output: target }); scrolling.start();
    assert.match(output, /\?1000h/); assert.match(output, /\?1006h/); scrolling.stop();
  } finally { if (previous === undefined) delete process.env.HABOR_MOUSE_SCROLL; else process.env.HABOR_MOUSE_SCROLL = previous; }
});

test('markdown emphasis survives default style values and code spans', () => {
  const lines = renderMarkdown('**important `code`** and *thought*', THEME, 76);
  const segments = lines.flat();
  assert.equal(segments.find(s => s.text.includes('important')).style.bold, true);
  assert.equal(segments.find(s => s.text === 'code').style.bold, true);
  assert.equal(segments.find(s => s.text === 'thought').style.italic, true);
});

test('structured upstream errors and tool results remain readable through repaint and the next submission', async () => {
  let events;
  const { view, text } = setup({ onInput: async input => {
    if (input === 'first') {
      events.accept({ type: 'tool_result', toolResult: { id: 'bad', name: 'Read', output: { message: 'tool failed', code: 42 }, isError: true } });
      events.accept({ type: 'error', error: { message: { error: { message: 'upstream failed' } } } });
    } else events.accept({ type: 'message', delta: { text: 'recovered' } });
  } });
  events = new TurnEvents(view);
  view.setInput('first'); view.handleKey({ name: 'return' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.status, 'idle');
  assert.match(text(), /tool failed/); assert.match(text(), /upstream failed/);
  assert.doesNotMatch(text(), /\[object Object\]/);
  assert.doesNotThrow(() => { view.tick(); view.setBusy(false); view.paint(); });
  view.setInput('next'); view.handleKey({ name: 'return' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(text(), /recovered/);
  assert.ok(view.blocks.every(block => typeof block.text === 'string'));
});

test('renderer tolerates non-string blocks already in the transcript', () => {
  const { view, text } = setup();
  const circular = { payload: 'retained' }; circular.self = circular;
  view.blocks.push({ kind: 'tool', text: { message: 'structured tool output' }, meta: { name: { text: 'tool' }, input: circular, status: 'error' } });
  view.blocks.push({ kind: 'assistant', text: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] });
  view.blocks.push({ kind: 'thinking', text: null });
  view.blocks.push({ kind: 'usage', text: 0 });
  assert.doesNotThrow(() => { view.paint(); view.setBusy(false); });
  assert.match(text(), /structured tool output/); assert.match(text(), /hello world/);
});

test('display text normalization covers content wrappers, primitives, ANSI and circular data', async () => {
  const { toDisplayText } = await import('../../core/dist/index.js');
  const { stripAnsi } = await import('../dist/tui/vendor/util.js');
  assert.equal(stripAnsi({ message: '\x1b[31mfailed\x1b[0m' }), 'failed');
  assert.equal(toDisplayText([{ type: 'content', content: { type: 'text', text: 'one' } }, { text: 'two' }]), 'one\ntwo');
  assert.equal(toDisplayText(null), ''); assert.equal(toDisplayText(0), '0'); assert.equal(toDisplayText(false), 'false');
  assert.equal(toDisplayText(new Error('failure')), 'failure');
  assert.match(toDisplayText({ code: 42 }), /"code": 42/);
  const circular = {}; circular.error = circular;
  assert.equal(toDisplayText(circular), '[Circular]');
});
