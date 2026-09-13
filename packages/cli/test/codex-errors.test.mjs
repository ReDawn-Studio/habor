import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {CodexNativeAdapter} from '../../adapters/dist/codex-native.js';

test('duplicate Codex error notifications render once per turn and the session can recover', async () => {
  const before = process.env.HABOR_CODEX_BIN;
  process.env.HABOR_CODEX_BIN = fileURLToPath(new URL('./fixtures/codex-errors.cjs', import.meta.url));
  const session = await new CodexNativeAdapter().createSession({model:'GPT-6 Astra',modelId:'gpt-6-astra',cwd:process.cwd()});
  try {
    for(let index=0;index<2;index++) {
      const events=[]; for await(const event of session.prompt('hello')) events.push(event);
      const errors=events.filter(event=>event.type==='error');
      assert.equal(errors.length,1);
      assert.equal(errors[0].error.code,'CODEX_UPGRADE_REQUIRED');
      assert.match(errors[0].error.message,/codex update/);
      assert.equal(events.at(-1).type,'done');
    }
    const third=[];for await(const event of session.prompt('retry')) third.push(event);
    assert.equal(third.filter(event=>event.type==='error').length,0);
    assert.equal(third.find(event=>event.type==='message').delta,'Recovered');
  } finally {
    await session.close();
    if(before===undefined) delete process.env.HABOR_CODEX_BIN; else process.env.HABOR_CODEX_BIN=before;
  }
});
