import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandInvocation, executableOnPath } from '../../core/dist/index.js';
import { hasCommand, runCli } from '../../adapters/dist/base.js';
import { runAgentCommand } from '../dist/agent-process.js';
import { dshAcpSpec } from '../../adapters/dist/specs-acp.js';
import { fileURLToPath } from 'node:url';

test('Windows npm shims launch Node directly and preserve JSON, spaces and shell metacharacters', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'habor Windows 中文 '));
  try {
    const entry = join(dir, 'node_modules', 'fixture', 'cli.cjs');
    mkdirSync(join(dir, 'node_modules', 'fixture'), { recursive: true });
    writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const shim = join(dir, 'agent.cmd');
    writeFileSync(shim, '@ECHO off\r\n"node" "%dp0%\\node_modules\\fixture\\cli.cjs" %*\r\n');
    // An extensionless Unix shim next to the .cmd must not win on Windows.
    writeFileSync(join(dir, 'agent'), '#!/bin/sh\nexit 1\n');
    assert.equal(executableOnPath(join(dir, 'agent')).toLowerCase(), shim.toLowerCase());
    const args = ['space 中文', '{"path":"C:\\a b\\","effort":"high"}', '& echo wrong', '%PATH%', '^|<>', '"quoted"', ''];
    const invocation = commandInvocation(shim, args);
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [entry, ...args]);
    const result = await runCli({ cmd: shim, argv: args, cwd: dir });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), args);
    const managed = await runAgentCommand({ command: shim, args, cwd: dir });
    assert.equal(managed.code, 0);
    assert.deepEqual(JSON.parse(managed.output), args);
    assert.equal(await hasCommand(shim), true);
    assert.equal(await hasCommand(join(dir, 'missing')), false);
    assert.deepEqual(commandInvocation(process.execPath, args), { command: process.execPath, args });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Windows bundled npm resolves to its JavaScript CLI without executing cmd.exe', { skip: process.platform !== 'win32' }, async () => {
  const launch = commandInvocation('npm', ['--version']);
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0], /npm-cli\.js$/i);
  const result = await runCli({ cmd: 'npm', argv: ['--version'], timeoutMs: 15000 });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('DSH bridge entry is an OS path even outside the repository working directory', () => {
  const previous = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.equal(dshAcpSpec.command({ model: 'test' }).argv[0], fileURLToPath(new URL('../../dsh-acp/dist/index.js', import.meta.url)));
  } finally { process.chdir(previous); }
});

test('Windows cancellation stops the native process behind a Node launcher', { skip: process.platform !== 'win32' }, async () => {
  const controller = new AbortController();
  let descendant;
  const script = 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(child.pid);setInterval(()=>{},1000);';
  await assert.rejects(runAgentCommand({ command: process.execPath, args: ['-e', script], cwd: tmpdir() }, {
    signal: controller.signal,
    onOutput(line) { descendant = Number(line); controller.abort(); }
  }), /取消/);
  assert.ok(Number.isInteger(descendant) && descendant > 0);
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});
