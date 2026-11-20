import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withoutManagedBlocks } from './delegation.ts';
import { removePath, worktreesRoot } from './worktree.ts';

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
 * The plugin rewrites its own instruction blocks here after an update. A checkpoint does not commit a file whose only
 * change is such a refresh (the owner decides), and worker copies never refresh them (see readDelegation), so a
 * worker's patch carries only real edits.
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
const exists = (p: string) => lstat(p).then(() => true, () => false); // a dangling symlink exists too

/** A file of the plugin's folder whose change is only a refreshed managed block, not an edit by a task or the owner. */
async function onlyBlockRefresh(top: string, file: string): Promise<boolean> {
  // The plugin writes regular files: a symlink, a folder or a missing file is an edit by someone else.
  if (!(await lstat(path.join(top, file)).then(s => s.isFile(), () => false))) return false;
  if ((await git(top, ['--literal-pathspecs', 'ls-tree', 'HEAD', '--', file]).catch(() => '')).split(' ')[0] === '120000') return false;
  const now = await readFile(path.join(top, file), 'utf8').catch(() => null);
  const before = await git(top, ['show', `HEAD:${file}`]).catch(() => null);
  if (now === null || before === null || withoutManagedBlocks(now) !== withoutManagedBlocks(before)) return false;
  // A changed executable bit is an edit too.
  const headMode = (await git(top, ['--literal-pathspecs', 'ls-tree', 'HEAD', '--', file]).catch(() => '')).split(' ')[0];
  const exec = await stat(path.join(top, file)).then(s => (s.mode & 0o111) !== 0, () => false);
  const filemode = (await git(top, ['config', '--type=bool', 'core.filemode']).catch(() => 'true')).trim() !== 'false';
  return !filemode || (headMode === '100755') === exec;
}

/**
 * Every change of the repository, one entry per file (`-uall`: a new folder is its files, not `dir/`). The whole
 * repository, not only this section: the copies are of the whole repository, and a section's task may change a file
 * above it (a root lockfile). A file in the plugin's folder whose only change is a refreshed block is listed apart.
 */
async function changes(root: string) {
  const r = await repo(root);
  const raw = await git(r.top, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames']);
  const all: Change[] = raw.split('\0').filter(Boolean).map(entry => ({ status: entry.slice(0, 2), path: entry.slice(3) })).sort(byPath);
  const files: Change[] = [], plugin: Change[] = [];
  for (const c of all) (c.path.startsWith(r.own) && await onlyBlockRefresh(r.top, c.path) ? plugin : files).push(c);
  // The token pins the exact content and the executable bit: a file someone edits after the list makes the commit refuse.
  const hash = createHash('sha256').update(line(await git(r.top, ['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => 'none')));
  for (const c of files) {
    const full = path.join(r.top, c.path);
    const mode = await lstat(full).then(s => s.isSymbolicLink() ? 'l' : s.isDirectory() ? 'd' : s.mode & 0o111 ? 'x' : '-', () => 'deleted');
    hash.update(`\0${c.status}\0${c.path}\0${mode}\0`);
    // A folder in the list is a submodule: its checked-out commit and its dirt are what gets committed.
    const content = mode === 'l' ? readlink(full).then(t => Buffer.from(t))
      : mode === 'd' ? git(full, ['rev-parse', 'HEAD']).then(async head => Buffer.from(head + await git(full, ['status', '--porcelain'])))
      : readFile(full);
    hash.update((await content.catch(() => null)) ?? '');
  }
  return { ...r, files, plugin, token: hash.digest('hex').slice(0, 32) };
}

export async function listChanges(input: { root: string }) {
  const c = await changes(input.root);
  return { files: c.files, plugin: c.plugin, token: c.token };
}

/** States in which a commit would not be the coordinator's checkpoint, or would silently drop someone's work. */
async function refuseUnsafe(top: string, files: Change[], plugin: Change[]) {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (await exists(line(await git(top, ['rev-parse', '--path-format=absolute', '--git-path', name]))))
      throw new Error('В репозитории не завершено слияние, rebase или cherry-pick: завершите его, потом снова checkpoint.');
  }
  if (await exists(line(await git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock']))))
    throw new Error('Индекс занят другим процессом git (index.lock). Дождитесь его завершения и повторите checkpoint.');
  const conflict = files.find(f => f.status.includes('U') || f.status === 'AA' || f.status === 'DD');
  if (conflict) throw new Error(`В файле ${conflict.path} не разрешён конфликт слияния.`);
  // Something staged by hand (a `git rm --cached`, an `add --chmod`, a partial `add -p`) is a decision the disk does
  // not show; the checkpoint does not guess it. The owner or the coordinator commits or unstages it first.
  const staged = [...files, ...plugin].filter(f => f.status[0] !== ' ' && f.status[0] !== '?').map(f => f.path);
  // No ready-made command: which version to keep is the owner's decision, and a pasted command could lose one.
  if (staged.length) throw new Error(`В индексе уже есть изменения (пути от корня репозитория): ${staged.slice(0, 20).join(', ')}${staged.length > 20 ? ` и ещё ${staged.length - 20}` : ''}. Пусть владелец закоммитит их или уберёт из индекса, потом снова checkpoint.`);
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
  await refuseUnsafe(c.top, c.files, c.plugin);
  if (!c.files.length) return { committed: false as const, files: [] as string[] };
  // Nothing is staged (refuseUnsafe), so HEAD plus the listed working-tree changes is exactly the list. A path git
  // reports deleted is deleted even if a folder of that name appeared (its files are listed on their own), and
  // nothing is added with -f: an ignored file is never committed.
  const present: string[] = [], missing: string[] = [];
  for (const f of c.files) (f.status[1] === 'D' || !(await exists(path.join(c.top, f.path))) ? missing : present).push(f.path);
  const gitDir = line(await git(c.top, ['rev-parse', '--path-format=absolute', '--git-dir']));
  const index = path.join(gitDir, `aif-checkpoint-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  const hasHead = await git(c.top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).then(() => true, () => false);
  try {
    await git(c.top, hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], undefined, env);
    if (missing.length) await git(c.top, ['--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', '-r', ...FROM_STDIN], nul(missing), env);
    if (present.length) await git(c.top, ['--literal-pathspecs', 'add', '-A', ...FROM_STDIN], nul(present), env);
    await git(c.top, ['commit', '-q', '-m', input.message], undefined, env);
  } finally { await removePath(index).catch(() => undefined); }
  const sha = line(await git(c.top, ['rev-parse', 'HEAD']));
  // A pre-commit hook may stage more files: they are named, not hidden.
  const committed = (await git(c.top, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', ...(hasHead ? [] : ['--root']), 'HEAD'])).split('\0').filter(Boolean);
  const listed = new Set(c.files.map(f => f.path));
  const extra = committed.filter(f => !listed.has(f));
  // The real index catches up for these paths only (and for what a hook added): they now match HEAD.
  await git(c.top, ['--literal-pathspecs', 'reset', '-q', ...FROM_STDIN], nul([...c.files.map(f => f.path), ...extra])).catch((cause: Error) => {
    throw new Error(`Коммит ${sha.slice(0, 12)} создан, но индекс не обновился (${cause.message.slice(0, 300)}). Выполните git reset -q -- <эти файлы>, затем продолжайте.`);
  });
  return { committed: true as const, sha, files: c.files.map(f => f.path), ...(extra.length ? { extra } : {}) };
}

export async function headCommit(input: { root: string }) {
  return { sha: line(await git(input.root, ['rev-parse', '--verify', 'HEAD^{commit}'])) };
}

// The project's own git settings (diff.relative, diff.noprefix, diff.context, color.diff, renames, external diff
// tools, text conversion) stay out of the patch.
const DIFF = ['diff', '--cached', '--binary', '-U3', '--no-color', '--no-relative', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

type Saved = { file: string; data: Buffer | null; mode: number; link: string | null };
async function save(top: string, file: string): Promise<Saved> {
  const full = path.join(top, file);
  const info = await lstat(full).catch(() => null);
  if (!info) return { file, data: null, mode: 0, link: null };
  if (info.isSymbolicLink()) return { file, data: null, mode: 0, link: await readlink(full) };
  return { file, data: info.isFile() ? await readFile(full) : null, mode: info.mode & 0o777, link: null };
}
const same = (a: Saved, b: Saved) => a.link === b.link && a.mode === b.mode
  && (a.data === null ? b.data === null : b.data !== null && a.data.equals(b.data));
async function restore(top: string, s: Saved) {
  if (same(s, await save(top, s.file))) return; // untouched by the failed apply
  const full = path.join(top, s.file);
  await removePath(full);
  if (s.link !== null) { await mkdir(path.dirname(full), { recursive: true }); await symlink(s.link, full); }
  else if (s.data !== null) { await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, s.data, { mode: s.mode }); }
}

/**
 * Brings one worker's result into the coordinator's workspace: what the worker changed in its copy since the last
 * bring-back of this worker (tracked, new and deleted files; ignored files such as node_modules stay out), so a
 * worker asked to fix its work is brought back again with just the fix. Without --3way `git apply` never touches the
 * index and refuses a patch that does not fit before writing anything; if writing then fails (a locked or read-only
 * file), the files it already touched are put back, so the workspace stays as it was and a retry is a normal one.
 */
export async function bringBack(input: { root: string; copy: string }) {
  const copy = path.resolve(input.copy);
  const inside = path.relative(worktreesRoot(), copy);
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error(`${copy} не копия AI Factory`);
  const mine = await repo(input.root);
  // The worker may have renamed its own section: git still works from the nearest folder of the copy that exists.
  let probe = copy;
  while (!(await exists(probe)) && path.relative(worktreesRoot(), path.dirname(probe)).split(path.sep).length >= 2) probe = path.dirname(probe);
  const theirs = await repo(probe);
  const common = async (dir: string) => path.resolve(line(await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])));
  if (await common(mine.top) !== await common(theirs.top)) throw new Error(`${copy} — копия другого репозитория`);
  // The copy's own git folder (one per worktree) remembers the tree that was brought back last.
  const mark = line(await git(theirs.top, ['rev-parse', '--path-format=absolute', '--git-path', 'aif-brought-back']));
  const last = (await readFile(mark, 'utf8').catch(() => '')).trim();
  const base = /^[0-9a-f]{40,64}$/.test(last) && await git(theirs.top, ['cat-file', '-e', `${last}^{tree}`]).then(() => true, () => false) ? last : 'HEAD';
  await git(theirs.top, ['add', '-A']);
  const tree = line(await git(theirs.top, ['write-tree']));
  const files = (await git(theirs.top, ['diff', '--cached', '--name-only', '-z', '--no-relative', '--no-renames', '--ignore-submodules=none', base])).split('\0').filter(Boolean);
  if (!files.length) return { applied: false as const, empty: true as const, files };
  // `git apply` without --index cannot move a submodule: say so instead of reporting a transfer that did not happen.
  const raw = await git(theirs.top, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--ignore-submodules=none', base]);
  const tokens = raw.split('\0'), gitlinks: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) if (/^:(160000 \S+|\S+ 160000) /.test(tokens[i])) gitlinks.push(tokens[i + 1]);
  if (gitlinks.length) return { applied: false as const, empty: false as const, files, error: `Исполнитель изменил подмодуль: ${gitlinks.join(', ')}. Его не перенести патчем — перенесите вручную.` };
  // A patch that would empty the folder this chat works in (the worker renamed or removed it) is refused before
  // anything changes: the folder survives if a file on disk stays in it or the patch adds one.
  if (mine.prefix) {
    const deleted = new Set<string>(), added: string[] = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      if (/ D$/.test(tokens[i])) deleted.add(tokens[i + 1]); else added.push(tokens[i + 1]);
    }
    const keeps = async (dir: string, rel: string): Promise<boolean> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const r = rel + entry.name;
        if (entry.isDirectory() && !entry.isSymbolicLink()) { if (await keeps(path.join(dir, entry.name), r + '/')) return true; }
        else if (!deleted.has(r)) return true;
      }
      return false;
    };
    if (!added.some(f => f.startsWith(mine.prefix)) && !(await keeps(path.resolve(input.root), mine.prefix)))
      return { applied: false as const, empty: false as const, files,
        error: `Исполнитель переименовал или удалил папку ${mine.prefix}, в которой работает этот чат: перенесите это вручную, после остальных задач.` };
  }
  // The receipt is written after the apply; a copy where it cannot be written is refused before anything changes.
  await writeFile(mark, last ? `${last}\n` : '').catch((cause: Error) => { throw new Error(`Копия исполнителя недоступна для записи: ${cause.message}`); });
  const dir = await mkdtemp(path.join(tmpdir(), 'aif-patch-'));
  const patch = path.join(dir, `${randomUUID()}.patch`);
  try {
    await git(theirs.top, [...DIFF, base, `--output=${patch}`]);
    try { await git(mine.top, ['apply', '--check', '--whitespace=nowarn', patch]); }
    catch (cause) { return { applied: false as const, empty: false as const, files, error: (cause as Error).message }; }
    const saved = await Promise.all(files.map(f => save(mine.top, f)));
    // --whitespace=nowarn: `apply.whitespace=fix` in the project would strip the trailing spaces of a Markdown line break.
    const undo = async (error: string) => {
      const lost: string[] = [];
      for (const s of saved) await restore(mine.top, s).catch(() => lost.push(s.file));
      return lost.length
        ? { applied: false as const, empty: false as const, partial: true as const, files: lost, error }
        : { applied: false as const, empty: false as const, files, error };
    };
    try { await git(mine.top, ['apply', '--whitespace=nowarn', patch]); }
    catch (cause) { return undo((cause as Error).message); }
    await writeFile(mark, `${tree}\n`);
    return { applied: true as const, files };
  } finally { await removePath(dir).catch(() => undefined); }
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
