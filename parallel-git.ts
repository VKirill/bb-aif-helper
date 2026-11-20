import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { worktreesRoot } from './worktree.ts';

// Git steps of parallel /aif-implement that the coordinator used to type by hand. Paths never pass through a shell or
// an agent's copy and paste: git prints them NUL-separated and reads them back NUL-separated, so spaces, Cyrillic,
// `[]`, quotes and Windows separators reach git unchanged, and a rename or a deletion is just two more paths.

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: 32 << 20, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 2000)));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}
const nul = (list: string[]) => list.map(p => `${p}\0`).join('');
const FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

/** The plugin rewrites its own instruction blocks here after an update: never a task's change, never committed or applied. */
export const OWN_DIR = '.ai-factory/skill-context/';

async function repo(root: string) {
  const top = (await git(root, ['rev-parse', '--show-toplevel']).catch(() => { throw new Error(`${root} не в git-репозитории`); })).trim();
  const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim(); // `sec/` or '' — always with `/`
  return { top, prefix, own: prefix + OWN_DIR };
}

export type Change = { status: string; path: string };

/** Changes inside the workspace folder, relative to the repository top, one entry per file (`-uall`: never just `dir/`). */
async function changes(root: string) {
  const r = await repo(root);
  const raw = await git(r.top, ['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '-uall', '--no-renames', '--', r.prefix || '.']);
  const files: Change[] = raw.split('\0').filter(Boolean).map(entry => ({ status: entry.slice(0, 2), path: entry.slice(3) }))
    .filter(c => !c.path.startsWith(r.own)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // The token pins the exact content: a file someone edits after the list was shown makes the commit refuse.
  const hash = createHash('sha256').update((await git(r.top, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => 'none')).trim());
  for (const c of files) {
    hash.update(`\0${c.status}\0${c.path}\0`);
    hash.update((await readFile(path.join(r.top, c.path)).catch(() => null)) ?? 'deleted');
  }
  return { ...r, files, token: hash.digest('hex').slice(0, 32) };
}

export async function listChanges(input: { root: string }) {
  const c = await changes(input.root);
  return { files: c.files, token: c.token };
}

/**
 * Commits exactly the listed changes, after the coordinator has checked that every one of them is its own.
 * Refuses when anything changed since the list (another file appeared, a listed file was edited again).
 */
export async function checkpoint(input: { root: string; token: string; message: string }) {
  const c = await changes(input.root);
  if (c.token !== input.token) throw new Error('Изменения в папке поменялись после проверки. Запустите checkpoint без --token и проверьте список заново.');
  if (!c.files.length) return { committed: false as const, files: [] as string[] };
  const present: string[] = [], missing: string[] = [];
  for (const f of c.files) (await stat(path.join(c.top, f.path)).then(() => true, () => false) ? present : missing).push(f.path);
  if (present.length) await git(c.top, ['--literal-pathspecs', 'add', '-A', ...FROM_STDIN], nul(present));
  if (missing.length) await git(c.top, ['--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', ...FROM_STDIN], nul(missing));
  // A pathspec commit takes only these paths, even if something else was staged before.
  await git(c.top, ['--literal-pathspecs', 'commit', '-q', '-m', input.message, ...FROM_STDIN], nul(c.files.map(f => f.path)));
  return { committed: true as const, sha: (await git(c.top, ['rev-parse', 'HEAD'])).trim(), files: c.files.map(f => f.path) };
}

export async function headCommit(input: { root: string }) {
  return { sha: (await git(input.root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() };
}

// The project's own git settings (diff.relative, diff.noprefix, color.diff, external diff tools, text conversion)
// stay out of the patch.
const DIFF = ['diff', '--cached', '--binary', '--no-color', '--no-relative', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'];

/**
 * Brings one worker's result into the coordinator's workspace: everything the worker changed in its copy (tracked,
 * new and deleted files; ignored files such as node_modules stay out) except the plugin's own instruction blocks.
 * Without --3way `git apply` never touches the index and refuses a patch that does not fit before writing anything,
 * so a refused patch leaves the workspace and the results of earlier tasks exactly as they were.
 */
export async function bringBack(input: { root: string; copy: string }) {
  const copy = path.resolve(input.copy);
  const inside = path.relative(worktreesRoot(), copy);
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error(`${copy} не копия AI Factory`);
  const mine = await repo(input.root);
  const theirs = await repo(copy);
  const common = async (dir: string) => path.resolve((await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if (await common(mine.top) !== await common(theirs.top)) throw new Error(`${copy} — копия другого репозитория`);
  await git(theirs.top, ['add', '-A']);
  const spec = ['--', ':(top)', `:(top,exclude,literal)${theirs.own}`];
  const files = (await git(theirs.top, ['diff', '--cached', '--name-only', '-z', '--no-relative', 'HEAD', ...spec])).split('\0').filter(Boolean);
  if (!files.length) return { applied: false as const, empty: true as const, files };
  const dir = await mkdtemp(path.join(tmpdir(), 'aif-patch-'));
  const patch = path.join(dir, `${randomUUID()}.patch`);
  try {
    await git(theirs.top, [...DIFF, `--output=${patch}`, ...spec]);
    try { await git(mine.top, ['apply', '--check', patch]); }
    catch (cause) { return { applied: false as const, empty: false as const, files, error: (cause as Error).message }; }
    await git(mine.top, ['apply', patch]);
    return { applied: true as const, files };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The brief the coordinator wrote for a worker: an absolute path to a text file of at most 200 KB. */
export async function readBrief(input: { path: string }) {
  if (!path.isAbsolute(input.path)) throw new Error(`Нужен абсолютный путь к файлу задания: ${input.path}`);
  const info = await stat(input.path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Файла задания нет: ${input.path}`);
  if (info.size > 200_000) throw new Error('Файл задания больше 200 КБ.');
  return { text: (await readFile(input.path, 'utf8')).replace(/^\uFEFF/, '') };
}
