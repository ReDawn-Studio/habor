import { realpath, readdir, stat, open, readFile } from 'node:fs/promises';
import { relative, resolve, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Choose an absolute workspace directory');
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error('Workspace is not a directory');
  return root;
}
export async function contained(root, name = '.') {
  if (typeof name !== 'string' || name.includes('\0')) throw new Error('Invalid path');
  const target = await realpath(resolve(root, name));
  const rel = relative(await realpath(root), target);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Path escapes workspace');
  return target;
}
export async function listFiles(root, name = '.') {
  const path = await contained(root, name);
  const entries = (await readdir(path, { withFileTypes: true })).filter(x => !['.git', 'node_modules', '.DS_Store'].includes(x.name)).sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return { path: relative(root, path) || '.', entries: entries.slice(0, 500).map(x => ({ name:x.name, path:relative(root, join(path,x.name)), directory:x.isDirectory(), symlink:x.isSymbolicLink() })), truncated: entries.length > 500 };
}
export async function readText(root, name) {
  const path = await contained(root, name);
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Not a regular file');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, bytesRead).includes(0)) throw new Error('Binary files cannot be previewed');
    return { path:relative(root,path), text:buffer.subarray(0,Math.min(bytesRead,256*1024)).toString('utf8'), truncated:bytesRead > 256*1024 };
  } finally { await handle.close(); }
}
export async function diff(root) {
  const opts = { cwd:root, timeout:15000, maxBuffer:2*1024*1024, windowsHide:true };
  const args = ['-c','core.fsmonitor=false','-c','core.quotePath=false','--no-pager'];
  const [unstaged, staged, untracked] = await Promise.all([
    exec('git',[...args,'diff','--no-ext-diff','--no-textconv','--'],opts),
    exec('git',[...args,'diff','--cached','--no-ext-diff','--no-textconv','--'],opts),
    exec('git',[...args,'ls-files','--others','--exclude-standard','-z'],opts),
  ]);
  return { unstaged:unstaged.stdout, staged:staged.stdout, untracked:untracked.stdout.split('\0').filter(Boolean) };
}
export async function checks(root) {
  try {
    const path = await contained(root, 'package.json');
    const pkg = JSON.parse(await readFile(path,'utf8'));
    // The UI displays the actual script before the user explicitly runs it.
    return Object.entries(pkg.scripts ?? {}).filter(([name, command]) => ['test','typecheck','lint','check','build'].includes(name) && typeof command === 'string').map(([id,command])=>({id,command}));
  } catch { return []; }
}
