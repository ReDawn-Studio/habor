import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../dist/index.js';

function harness(makePrompt) {
  const sessions = [], inputs = [];
  const adapter = {
    id: 'dsh-acp', harnessName: 'Test', models: ['DeepSeek V4 Flash'],
    isAvailable: async () => true,
    createSession: async opts => {
      const session = {
        id: `session-${sessions.length}`, adapterId: 'dsh-acp', model: opts.model, cwd: opts.cwd,
        cancelled: false, closed: false,
        prompt(input) { inputs.push(input); return makePrompt(sessions.indexOf(session)); },
        async cancel() { this.cancelled = true; }, async close() { this.closed = true; }
      };
      sessions.push(session); return session;
    }
  };
  return { ...createRouter([adapter]), sessions, inputs };
}

test('delta-only streams persist one complete assistant turn', async () => {
  const { router } = harness(async function* () {
    yield { type: 'message', delta: '你好' };
    yield { type: 'message', delta: ' world' };
    yield { type: 'message', text: '你好 world' };
    yield { type: 'done' };
  });
  const task = await router.newTask({ model: 'DeepSeek V4 Flash', cwd: '/test' });
  for await (const event of router.continueTask(task.id, 'hello')) { /* consume */ }
  assert.deepEqual(task.conversation.map(turn => turn.text), ['hello', '你好 world']);
});

test('stopping a hung transport releases the turn and restores context on continuation', async () => {
  let unblock;
  const { router, sessions, inputs } = harness(async function* (index) {
    if (index === 0) {
      yield { type: 'message', delta: 'partial answer' };
      await new Promise(resolve => { unblock = resolve; });
    } else yield { type: 'message', delta: 'continued answer' };
  });
  const task = await router.newTask({ model: 'DeepSeek V4 Flash', cwd: '/test' });
  const running = router.continueTask(task.id, 'initial request')[Symbol.asyncIterator]();
  await running.next();
  const waiting = running.next();
  await new Promise(resolve => setImmediate(resolve));
  await router.cancelTask(task.id);
  const result = await Promise.race([waiting, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('cancellation hung')), 500); timer.unref(); })]);
  assert.equal(result.done, true);
  assert.equal(sessions[0].cancelled, true); assert.equal(sessions[0].closed, true);
  for await (const event of router.continueTask(task.id, 'continue please')) { /* consume */ }
  assert.equal(sessions.length, 2);
  assert.match(inputs[1], /initial request/); assert.match(inputs[1], /partial answer/);
  assert.match(inputs[1], /continue please/);
  assert.deepEqual(task.conversation.map(turn => turn.text), ['initial request', 'partial answer', 'continue please', 'continued answer']);
  unblock();
});

test('concurrent turns are rejected without damaging the active session', async () => {
  const { router } = harness(async function* () { yield { type: 'message', delta: 'hello' }; });
  const task = await router.newTask({ model: 'DeepSeek V4 Flash', cwd: '/test' });
  const first = router.continueTask(task.id, 'first')[Symbol.asyncIterator]();
  await first.next();
  const second = router.continueTask(task.id, 'second')[Symbol.asyncIterator]();
  await assert.rejects(second.next(), /正在回复/);
  await first.return();
  for await (const event of router.continueTask(task.id, 'third')) { /* consume */ }
  assert.deepEqual(task.conversation.map(turn => turn.text), ['first', 'hello', 'third', 'hello']);
});

test('malformed adapter text is normalized before persistence and event delivery', async () => {
  const { router } = harness(async function* () {
    yield { type: 'message', text: [{ type: 'text', text: 'answer' }] };
    yield { type: 'message', delta: { text: ' continued' } };
    yield { type: 'tool_result', toolResult: { id: 'tool', name: 'Read', output: { message: 'tool error' } } };
    yield { type: 'error', error: { message: { message: 'upstream error' } } };
  });
  const task = await router.newTask({ model: 'DeepSeek V4 Flash', cwd: '/test' });
  const events = [];
  for await (const event of router.continueTask(task.id, 'hello')) events.push(event);
  assert.equal(events[0].text, 'answer'); assert.equal(events[1].delta, ' continued');
  assert.equal(events[2].toolResult.output, 'tool error'); assert.equal(events[3].error.message, 'upstream error');
  assert.deepEqual(task.conversation.map(turn => turn.text), ['hello', 'answer continued']);
});

test('resuming a completed task reopens only its latest binding and keeps its workspace identity', async () => {
  const { router, sessions } = harness(async function* () { yield { type: 'message', delta: 'saved answer' }; });
  const task = await router.newTask({ model: 'DeepSeek V4 Flash', cwd: '/workspace/project' });
  for await (const event of router.continueTask(task.id, 'save this context')) { /* consume */ }
  await router.finishTask(task.id, 'done');
  assert.equal(task.status, 'done');
  const resumed = router.resumeTask(task.id);
  assert.equal(resumed.status, 'active');
  assert.equal(router.status(task.id).target.model, 'DeepSeek V4 Flash');
  assert.equal(task.cwd, '/workspace/project');
  assert.equal(task.bindings.filter(binding => binding.endedAt === undefined).length, 1);
  assert.equal(sessions.length, 1); // Session is lazily reconstructed on the next turn.
});
