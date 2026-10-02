#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { DesktopService } from './service.mjs';

// stdout is a protocol channel; dependency diagnostics belong on stderr.
const write = (message) => process.stdout.write(JSON.stringify(message) + '\n');
console.log = (...args) => console.error(...args);
const service = new DesktopService({ emit: event => write({ event }) });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 8000);
  await service.close(); clearTimeout(timeout); process.exit(0);
}
input.on('line', async line => {
  let request;
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Request exceeds 1 MiB');
    request = JSON.parse(line);
    const result = await service.call(request.method, request.params ?? {});
    write({ id: request.id, result });
  } catch (error) { write({ id: request?.id, error: service.safeError(error) }); }
});
input.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
