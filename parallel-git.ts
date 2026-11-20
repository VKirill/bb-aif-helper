import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { worktreesRoot } from './worktree.ts';

// Git steps of parallel /aif-implement that the coordinator used to type by hand. Paths never pass through a shell or
// an agent's copy and paste: git prints them NUL-separated and reads them back NUL-separated, so spaces, Cyrillic,
// `[]`, quotes and Windows separators reach git unchanged, and a rename or a deletion is just two more paths.

function git(cwd: string, args: string[], input?: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: 32 << 20, encoding: 'utf8', env: env ? { ...process.env, ...env } : undefined }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 2000)));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}
const nul = (list: string[]) => list.map(p => `${p}\0`).join('');
const FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

/**
 * The plugin rewrites its own instruction blocks here after an update. A checkpoint never commits them (the owner
 * decides), and worker copies never refresh them (see readDelegation), so a worker's patch carries only real edits.
 */
export const OWN_DIR = '.ai-factory/skill-context/';

// git ends its answer with a newline; a path may itself start or end with a space, so nothing else is trimmed.
const line = (text: string) => text.replace(/\r?\n$/, '');

async function repo(root: string) {
  const top = line(await git(root, ['rev-parse', '--show-toplevel']).catch(() => { throw new Error(`${root} не в git-репозитории`); }));
  const prefix = line(await git(root, ['rev-parse', '--show-prefix'])); // `sec/` or '' — always with `/`
  return { top, prefix, own: prefix + OWN_DIR };
}

export type Change = { status: string; path: string };
const byPath = (a: Change, b: Change) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Every change of the repository, one entry per file (`-uall`: a new folder is its files, not `dir/`). The whole
 * repository, not only this section: the copies are of the whole repository, and a section's task may change a file
 * above it (a root lockfile).
 */
async function changes(root: string) {
  const r = await repo(root);
  const raw = await git(r.top, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames']);
  const all: Change[] = raw.split('\0').filter(Boolean).map(entry => ({ status: entry.slice(0, 2), path: entry.slice(3) })).sort(byPath);
  const files = all.filter(c => !c.path.startsWith(r.own)), plugin = all.filter(c => c.path.startsWith(r.own));
  // The token pins the exact content and the executable bit: a file someone edits after the list makes the commit refuse.
  const hash = createHash('sha256').update(line(await git(r.top, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => 'none')));
  for (const c of files) {
    const full = path.join(r.top, c.path);
    const mode = await stat(full).then(s => s.mode & 0o111 ? 'x' : '-', () => 'deleted');
    hash.update(`\0${c.status}\0${c.path}\0${mode}\0`);
    hash.update((await readFile(full).catch(() => null)) ?? '');
  }
  return { ...r, files, plugin, token: hash.digest('hex').slice(0, 32) };
}

export async function listChanges(input: { root: string }) {
  const c = await changes(input.root);
  return { files: c.files, plugin: c.plugin, token: c.token };
}

/**
 * Commits exactly the listed changes, after the coordinator has checked that every one of them is its own.
 * Refuses when anything changed since the list (another file appeared, a listed file was edited again).
 * The commit is built in a temporary index from HEAD plus these files, so whatever else was staged stays staged and
 * out of the commit, a file replaced by a folder of the same name works, and a rejected commit (a pre-commit hook)
 * leaves the real index exactly as it was.
 */
export async function checkpoint(input: { root: string; token: string; message: string }) {
  const c = await changes(input.root);
  if (c.token !== input.token) throw new Error('Изменения в репозитории поменялись после проверки. Запустите checkpoint без --token и проверьте список заново.');
  if (!c.files.length) return { committed: false as const, files: [] as string[] };
  const present: string[] = [], missing: string[] = [];
  for (const f of c.files) (await stat(path.join(c.top, f.path)).then(() => true, () => false) ? present : missing).push(f.path);
  const gitDir = line(await git(c.top, ['rev-parse', '--path-format=absolute', '--git-dir']));
  const index = path.join(gitDir, `aif-checkpoint-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const hasHead = await git(c.top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).then(() => true, () => false);
    await git(c.top, hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], undefined, env);
    if (missing.length) await git(c.top, ['--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', '-r', ...FROM_STDIN], nul(missing), env);
    if (present.length) await git(c.top, ['--literal-pathspecs', 'add', '-A', ...FROM_STDIN], nul(present), env);
    await git(c.top, ['commit', '-q', '-m', input.message], undefined, env);
  } finally { await rm(index, { force: true }); }
  // The real index catches up for these paths only: they now match HEAD.
  await git(c.top, ['--literal-pathspecs', 'reset', '-q', ...FROM_STDIN], nul(c.files.map(f => f.path)));
  return { committed: true as const, sha: line(await git(c.top, ['rev-parse', 'HEAD'])), files: c.files.map(f => f.path) };
}

export async function headCommit(input: { root: string }) {
  return { sha: line(await git(input.root, ['rev-parse', '--verify', 'HEAD^{commit}'])) };
}

// The project's own git settings (diff.relative, diff.noprefix, color.diff, renames, external diff tools, text
// conversion) stay out of the patch. Without renames every path is its own entry, so one can be applied alone.
const DIFF = ['diff', '--cached', '--binary', '--no-color', '--no-relative', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'];
// `git apply --include` takes a glob: `[`, `*`, `?` and `\` in a file name are matched literally.
const literalGlob = (file: string) => file.replace(/[\\*?[\]]/g, '\\$&');

/**
 * Brings one worker's result into the coordinator's workspace: everything the worker changed in its copy (tracked,
 * new and deleted files; ignored files such as node_modules stay out). Without --3way `git apply` never touches the
 * index and refuses a patch that does not fit before writing anything, so a refused patch leaves the workspace and
 * the results of earlier tasks exactly as they were. If writing stopped half way (a locked or read-only file), a
 * retry applies only the files that are not there yet.
 */
export async function bringBack(input: { root: string; copy: string }) {
  const copy = path.resolve(input.copy);
  const inside = path.relative(worktreesRoot(), copy);
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error(`${copy} не копия AI Factory`);
  const mine = await repo(input.root);
  const theirs = await repo(copy);
  const common = async (dir: string) => path.resolve(line(await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])));
  if (await common(mine.top) !== await common(theirs.top)) throw new Error(`${copy} — копия другого репозитория`);
  await git(theirs.top, ['add', '-A']);
  const files = (await git(theirs.top, ['diff', '--cached', '--name-only', '-z', '--no-relative', '--no-renames', 'HEAD'])).split('\0').filter(Boolean);
  if (!files.length) return { applied: false as const, empty: true as const, files };
  const dir = await mkdtemp(path.join(tmpdir(), 'aif-patch-'));
  const patch = path.join(dir, `${randomUUID()}.patch`);
  const fits = (args: string[]) => git(mine.top, ['apply', '--check', ...args, patch]).then(() => null, (cause: Error) => cause.message);
  try {
    await git(theirs.top, [...DIFF, `--output=${patch}`]);
    const whole = await fits([]);
    let only: string[] | null = null;
    if (whole) {
      // Does not fit as a whole: either a real conflict, or an earlier try stopped half way. Each file is either
      // still to apply, already applied (its reverse fits) or in conflict; one conflict refuses everything.
      const pending: string[] = [];
      for (const f of files) {
        const include = [`--include=${literalGlob(f)}`];
        if (!await fits(include)) pending.push(f);
        else if (await fits(['-R', ...include])) return { applied: false as const, empty: false as const, files, error: whole };
      }
      only = pending;
    }
    try {
      if (!only) await git(mine.top, ['apply', patch]);
      else if (only.length) await git(mine.top, ['apply', ...only.map(f => `--include=${literalGlob(f)}`), patch]);
    } catch (cause) {
      return { applied: false as const, empty: false as const, partial: true as const, files, error: (cause as Error).message };
    }
    return { applied: true as const, files };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * The brief the coordinator wrote for a worker: an absolute path to a text file of at most 200 KB. Windows
 * PowerShell 5.1 writes UTF-16 with a BOM by default (`Out-File`, `>`), so that is read too; anything else that is
 * not UTF-8 is refused rather than sent to the worker as garbage.
 */
export async function readBrief(input: { path: string }) {
  if (!path.isAbsolute(input.path)) throw new Error(`Нужен абсолютный путь к файлу задания: ${input.path}`);
  const info = await stat(input.path).catch(() => null);
  if (!info?.isFile()) throw new Error(`Файла задания нет: ${input.path}`);
  if (info.size > 200_000) throw new Error('Файл задания больше 200 КБ.');
  const bytes = await readFile(input.path);
  let text: string | null = null;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0));
  } catch { /* not valid in its encoding */ }
  if (text === null || text.includes('\0')) throw new Error('Файл задания не в UTF-8 и не в UTF-16 с BOM: сохраните его в UTF-8.');
  return { text };
}
