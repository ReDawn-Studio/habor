import http from 'node:http';
import { DesktopService } from './service.mjs';
const clients = new Set();
const service = new DesktopService({ emit: event => { const data = `data: ${JSON.stringify(event)}\n\n`; for (const response of clients) response.write(data); } });
const cwdIndex = process.argv.indexOf('--cwd');
if (cwdIndex >= 0 && process.argv[cwdIndex + 1]) {
  await service.call('workspace.open', { path: process.argv[cwdIndex + 1] });
}
function send(response, status, body) { response.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'access-control-allow-origin':'*' }); response.end(JSON.stringify(body)); }
const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') { response.writeHead(204, {'access-control-allow-origin':'*','access-control-allow-headers':'content-type'}); return response.end(); }
  if (request.url === '/events') { response.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*'}); response.write(`data: ${JSON.stringify({type:'ready'})}\n\n`); clients.add(response); request.on('close',()=>clients.delete(response)); return; }
  if (request.method !== 'POST' || request.url !== '/rpc') return send(response,404,{error:'Not found'});
  let raw=''; for await (const chunk of request) raw += chunk;
  try { const requestBody=JSON.parse(raw); const result=await service.call(requestBody.method,requestBody.params||{}); send(response,200,{id:requestBody.id,result}); }
  catch(error) { send(response,400,{error:service.safeError(error)}); }
});
const port = Number(process.argv[process.argv.indexOf('--port')+1] || 0);
server.listen(port,'127.0.0.1',()=>console.log(`HABOR_APP_SERVER_PORT:${server.address().port}`));
const shutdown=async()=>{ await service.close(); server.close(()=>process.exit(0)); };
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
