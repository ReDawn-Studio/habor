import test from 'node:test';
import assert from 'node:assert/strict';
import { describeAgentError } from '../../core/dist/index.js';
import { AppView } from '../dist/tui/app.js';
import { TurnEvents } from '../dist/tui/events.js';
import { renderEvent } from '../dist/render.js';

const subscriptionBody = '400: {"code":"InvalidSubscription","message":"Your account (example) does not have a valid AgentPlan subscription, or your subscription has expired."}';

test('ACP Internal error unwraps data.details and explains the provider subscription failure', () => {
  const error = Object.assign(new Error('Internal error'), { code: -32603, data: { details: subscriptionBody } });
  const result = describeAgentError(error);
  assert.equal(result.code, 'InvalidSubscription');
  assert.match(result.message, /订阅无效或已过期/);
  assert.match(result.message, /F3 \/providers/);
  assert.doesNotMatch(result.message, /Internal error|Your account/);
});

test('detailed native errors retain their cause and redact supplied credentials', () => {
  const key = 'test-secret-for-diagnostics';
  const result = describeAgentError({ message:'Internal error', data:{ error:{ code:'AUTH', message:`Authentication failed: ${key}` } } }, [key]);
  assert.equal(result.code,'AUTH');
  assert.equal(result.message,'Authentication failed: [REDACTED]');
  assert.equal(describeAgentError(new Error('ordinary failure')).message,'ordinary failure');
  const circular={message:'failure'};circular.data=circular;
  assert.equal(describeAgentError(circular).message,'failure');
});

test('the transcript shows the actual local provider and host once, and can recover after the error', () => {
  let frame;
  const view=new AppView({terminal:{cols:100,rows:26,paint(screen){frame=screen}},version:'test',onInput(){}});
  const events=new TurnEvents(view);
  const connection={type:'connection',connection:{agent:'DeepSeek Harness',providerId:'deepseek',providerName:'deepseek',modelId:'deepseek-v4-flash',endpointHost:'ark.cn-beijing.volces.com',sourceKind:'local'}};
  events.accept(connection);events.accept(connection);
  assert.equal(view.blocks.length,1);
  events.accept({type:'error',error:describeAgentError({message:'Internal error',data:{details:subscriptionBody}})});
  view.setBusy(false);
  const text=frame.cells.map(row=>row.map(cell=>cell.ch).join('')).join('\n');
  assert.match(text,/ark.cn-beijing.volces.com/);assert.match(text,/InvalidSubscription/);assert.match(text,/F3/);
  assert.match(renderEvent(connection),/ark.cn-beijing.volces.com/);
  view.clearMessages();events.accept(connection);assert.equal(view.blocks.length,1);
  events.accept({type:'message',delta:'recovered'});assert.equal(view.blocks.at(-1).text,'recovered');
});

test('serialized Codex API errors become a readable upgrade action', () => {
  const payload = { type:'error', status:400, error:{ type:'invalid_request_error', message:"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } };
  for (const source of [JSON.stringify(payload), new Error(JSON.stringify(payload)), { message: JSON.stringify(payload) }]) {
    const result = describeAgentError(source);
    assert.equal(result.code, 'CODEX_UPGRADE_REQUIRED');
    assert.match(result.message, /gpt-6-astra/);
    assert.match(result.message, /codex update/);
    assert.doesNotMatch(result.message, /"status"|"invalid_request_error"/);
  }
  const normal = describeAgentError(JSON.stringify({ error:{code:'example',message:'A useful error message'} }));
  assert.equal(normal.message,'A useful error message'); assert.equal(normal.code,'example');
});
