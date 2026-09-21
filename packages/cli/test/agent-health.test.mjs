import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { probeAgentProtocol } from '../../adapters/dist/index.js';

test('offline health validates a real initialize exchange without creating a session or requesting a prompt', async () => {
  const script = `
    const rl=require('node:readline').createInterface({input:process.stdin});
    rl.on('line',line=>{
      const req=JSON.parse(line);
      if(req.method!=='initialize')process.exit(10);
      console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:req.params.protocolVersion,agentCapabilities:{}}}));
    });
    rl.on('close',()=>process.exit(0));
  `;
  await probeAgentProtocol({ command:process.execPath,args:['-e',script],cwd:tmpdir(),protocol:'acp' });
});

test('offline health rejects incompatible, crashed and unresponsive servers with useful diagnostics', async () => {
  const opts={command:process.execPath,cwd:tmpdir(),protocol:'acp'};
  await assert.rejects(probeAgentProtocol({...opts,args:['-e','process.stdin.once("data",()=>console.log(JSON.stringify({id:1,result:{}})))']}),/不兼容/);
  await assert.rejects(probeAgentProtocol({...opts,args:['-e','console.error("missing native dependency");process.exit(4)']}),/missing native dependency/);
  await assert.rejects(probeAgentProtocol({...opts,args:['-e','setInterval(()=>{},1000)'],timeoutMs:100}),/握手超时/);
});
