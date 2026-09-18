import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters, createAcpBridgeAdapter } from '../../adapters/dist/index.js';

test('every router adapter is exposed through the ACP contract', () => {
  const adapters = createAdapters();
  assert.ok(adapters.length >= 5);
  assert.ok(adapters.every(adapter => adapter.protocol === 'acp'));
});

test('ACP bridge preserves legacy streaming events and lifecycle', async () => {
  const calls = [];
  const adapter = createAcpBridgeAdapter({
    id: 'fake-cli', harnessName: 'Fake CLI', models: ['Fake'],
    isAvailable: async () => true,
    async createSession(opts) {
      return {
        id: 'legacy-session', adapterId: 'fake-cli', model: opts.model, cwd: opts.cwd,
        async *prompt(input) {
          calls.push(`prompt:${input}`);
          yield { type: 'thinking', thinking: 'thinking' };
          yield { type: 'message', delta: 'answer' };
          yield { type: 'tool_call', tool: { id: 'tool-1', name: 'Read', input: { path: 'x' } } };
          yield { type: 'tool_result', toolResult: { id: 'tool-1', name: 'Read', output: 'ok' } };
          yield { type: 'done' };
        },
        async cancel() { calls.push('cancel'); },
        async close() { calls.push('close'); }
      };
    }
  });
  const session = await adapter.createSession({ model: 'Fake', modelId: 'fake', cwd: process.cwd(), permission: 'auto' });
  const events = [];
  for await (const event of session.prompt('hello')) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['thinking', 'message', 'tool_call', 'tool_result', 'done']);
  assert.equal(events[1].delta, 'answer');
  assert.equal(events[2].tool.name, 'Read');
  assert.deepEqual(calls, ['prompt:hello']);
  await session.close();
  assert.deepEqual(calls, ['prompt:hello', 'close']);
});
