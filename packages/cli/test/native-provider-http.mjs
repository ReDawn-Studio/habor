import http from 'node:http';
import { createAdapters } from '../../adapters/dist/index.js';
import assert from 'node:assert/strict';
import { CodexNativeAdapter } from '../../adapters/dist/codex-native.js';
import { ClaudeNativeAdapter } from '../../adapters/dist/claude-native.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const requests=[];
const key='habor-local-validation-key';
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 let body={};try{body=JSON.parse(raw)}catch{}
 requests.push({url:req.url,model:body.model,effort:body.reasoning?.effort ?? body.output_config?.effort ?? body.reasoning_effort,thinking:body.thinking?.type,keyMatched:req.headers.authorization===`Bearer ${key}`||req.headers['x-api-key']===key});
 const send=(type,payload)=>res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
 if(req.url.includes('responses')){
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const item={id:'msg_mock',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Local provider verified',annotations:[]}]};
  send('response.created',{type:'response.created',response:{id:'resp_mock',object:'response',status:'in_progress',output:[]}});
  send('response.output_item.added',{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}});
  send('response.content_part.added',{type:'response.content_part.added',item_id:'msg_mock',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  send('response.output_text.delta',{type:'response.output_text.delta',item_id:'msg_mock',output_index:0,content_index:0,delta:'Local provider verified'});
  send('response.output_item.done',{type:'response.output_item.done',output_index:0,item});
  send('response.completed',{type:'response.completed',response:{id:'resp_mock',object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:body.model,output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}});res.end();
 }else if(req.url.includes('chat/completions')){
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'chat_mock',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'Local provider verified'},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'chat_mock',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\n\n');
  res.end('data: [DONE]\n\n');
 }else if(req.url.includes('messages')){
  if(req.url.includes('count_tokens')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({input_tokens:10}));return}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  send('message_start',{type:'message_start',message:{id:'msg_mock',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}});
  send('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});
  send('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Local provider verified'}});
  send('content_block_stop',{type:'content_block_stop',index:0});
  send('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}});
  send('message_stop',{type:'message_stop'});res.end();
 }else {res.writeHead(200,{'Content-Type':'application/json'});res.end('{}')}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const dir=mkdtempSync(join(tmpdir(),'habor-native-'));
try{
 const cases=[['codex',new CodexNativeAdapter(),'gpt-6-astra','responses',`http://127.0.0.1:${port}/v1`],['claude',new ClaudeNativeAdapter(),'claude-fable-5','anthropic',`http://127.0.0.1:${port}`]];
 if(process.argv.includes('--all')) {
  const adapters=createAdapters();
  cases.push(['kimi',adapters.find(a=>a.id==='kimi-acp'),'k3','openai',`http://127.0.0.1:${port}/v1`],['zcode',adapters.find(a=>a.id==='zcode'),'glm-5.3','openai',`http://127.0.0.1:${port}/v1`],['dsh',adapters.find(a=>a.id==='dsh-acp'),'deepseek-v4-flash','openai',`http://127.0.0.1:${port}/v1`]);
 }
 const only=process.argv.find(arg=>arg.startsWith('--agent='))?.slice(8);
 for(const [name,adapter,modelId,protocol,baseUrl]of cases.filter(item=>!only||item[0]===only)){
  const reasoningTest=process.argv.includes('--reasoning');
  const session=await adapter.createSession({model:'Local test',modelId,cwd:dir,permission:'ask',
    ...(reasoningTest && name==='zcode'?{reasoningLevels:['low','high','max']}:{}),
    connection:{providerId:'local-mock',name:'Local mock',baseUrl,protocol,apiKey:key}});
  const timer=setTimeout(()=>void session.cancel(),45000);
  try {
    const capabilities=reasoningTest?await session.getReasoningCapabilities():undefined;
    const available=capabilities?.levels.map(level=>level.id)??[];
    const levels=reasoningTest?(available.includes('low')&&available.includes('max')?['low','max']:['off','on']):[undefined];
    if(reasoningTest)assert.ok(levels.every(level=>available.includes(level)), `${name}: unexpected capabilities ${available}`);
    for(const effort of levels) {
      const start=requests.length;
      if(effort) await session.setReasoningEffort(effort);
      const events=[];
      for await(const event of session.prompt('Say hello without using tools.'))events.push({type:event.type,text:event.delta??event.text,error:event.error?.message});
      assert.ok(!events.some(event=>event.type==='error'), `${name}: ${JSON.stringify(events)}`);
      assert.equal(events.filter(event=>event.type==='message').map(event=>event.text).join(''),'Local provider verified');
      const sent=requests.slice(start).filter(request=>request.model===modelId && request.keyMatched);
      assert.ok(sent.length, `${name}: provider or key was not applied`);
      if(effort) assert.ok(sent.some(request=>effort==='off'?request.thinking==='disabled':effort==='on'?request.thinking==='enabled'||request.thinking===undefined:request.effort===effort), `${name}: effort ${effort} not sent: ${JSON.stringify(sent)}`);
    }
    console.log(`${name}: actual native client verified ${reasoningTest?levels.join('/')+' reasoning, ':''}model, endpoint and key`);
  } finally {clearTimeout(timer);await session.close()}

 }
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true})}
