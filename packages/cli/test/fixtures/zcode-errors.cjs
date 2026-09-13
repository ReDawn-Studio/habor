// Local ZCode protocol replay: no model, credentials, network or workspace tools.
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = payload => send({ method: 'session/event', params: { payload } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!request.method) return;
  if (request.method === 'session/create') {
    send({ id: 'preferences', method: 'session/requestRuntimePreferences', params: { sessionId: 'replay-session' } });
  }
  send({ id: request.id, result: request.method === 'session/create' ? { snapshot: { settings: { model: { current: { providerId: 'local', modelId: 'glm-5.3' }, available: [] } } } } : {} });
  if (request.method !== 'session/send') return;
  if (request.params.content === 'retry') {
    event({ kind: 'text_delta', delta: 'Recovery succeeded' });
    event({ kind: 'complete', stopReason: 'end_turn' });
  } else {
    event({ kind: 'tool_call', toolCallId: 'read-file', toolName: 'Read', input: { path: 'example.txt' } });
    event({ kind: 'tool_execution_failed', toolCallId: 'read-file', toolName: 'Read', error: { code: 'TEST_TOOL_ERROR', message: 'Tool replay failure' } });
    event({ kind: 'error', error: { code: 'TEST_UPSTREAM_ERROR', message: 'Upstream replay failure' } });
  }
});
