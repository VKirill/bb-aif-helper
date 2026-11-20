import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Copies for parallel /aif-implement workers. The base folder may be a project root, a section folder with its
// own repository, or a subfolder of a larger repository: the copy forks the whole repository and the worker's
// folder is the same subfolder inside it. BB core forks only a project root that is itself a git checkout.

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await run('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: 4 << 20 })).stdout.trim();
const exists = (p: string) => stat(p).then(() => true, () => false);
const present = (p: string) => lstat(p).then(() => true, () => false);

/**
 * Deletes a file or folder and checks it is gone. On Windows Node's `rm` can return without an error and leave a
 * file whose path has non-ASCII characters (`раздел\a.txt`); `unlink` and `rmdir` delete it. A file another process
 * holds open stays visible for a moment, so the check waits up to about two seconds.
 */
export async function removePath(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  const walk = async (q: string): Promise<void> => {
    const info = await lstat(q).catch(() => null);
    if (!info) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(q).catch(() => [] as string[])) await walk(path.join(q, entry));
      await rmdir(q).catch(() => undefined);
    } else await unlink(q).catch(() => undefined);
  };
  for (let i = 0; i < 10 && await present(p); i++) {
    await walk(p);
    if (await present(p)) await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (await present(p)) throw new Error(`Не удалось удалить ${p}: его держит другой процесс`);
}

/** Every copy lives here, so removal never touches a folder this plugin did not make. */
export const worktreesRoot = () => path.join(homedir(), '.bb-aif-helper', 'worktrees');
export const WORKTREE_NAME = /^[A-Za-z0-9._-]{1,120}$/;
/** True for a path inside a copy made here: such a folder belongs to a parallel worker. */
export function insideWorktrees(p: string): boolean {
  const inside = path.relative(worktreesRoot(), path.resolve(p));
  return !!inside && inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside);
}

export type CreatedWorktree = { root: string; path: string; sha: string };

export async function createWorktree(input: { basePath: string; name: string; ref?: string }): Promise<CreatedWorktree> {
  if (!WORKTREE_NAME.test(input.name)) throw new Error(`Недопустимое имя копии: ${input.name}`);
  if (!path.isAbsolute(input.basePath)) throw new Error(`Нужен абсолютный путь: ${input.basePath}`);
  if (input.ref?.startsWith('-')) throw new Error(`Недопустимая ссылка: ${input.ref}`);
  const top = await git(input.basePath, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new Error(`${input.basePath} не в git-репозитории`);
  });
  // `git` trims its answer; a section name may start with a space, so the prefix is read untrimmed.
  const prefix = (await run('git', ['-C', input.basePath, 'rev-parse', '--show-prefix'], { timeout: 120_000 })).stdout.replace(/\r?\n$/, '');
  const sha = await git(top, ['rev-parse', '--verify', `${input.ref || 'HEAD'}^{commit}`]);
  const repoKey = `${path.basename(top)}-${createHash('sha256').update(top).digest('hex').slice(0, 8)}`;
  const root = path.join(worktreesRoot(), repoKey, input.name);
  await mkdir(path.dirname(root), { recursive: true });
  // mkdir without `recursive` claims the name atomically: of two launches with one name only one gets past here,
  // so the cleanup below never removes a copy another launch made.
  await mkdir(root).catch((cause: NodeJS.ErrnoException) => {
    throw cause.code === 'EEXIST' ? new Error(`Копия ${root} уже существует`) : cause;
  });
  // A copy deleted earlier without git may still be registered and would block `worktree add` for this name.
  await git(top, ['worktree', 'prune']).catch(() => '');
  // A copy that fails after git registered it (a post-checkout hook, a full disk, a missing section) is removed:
  // nothing else would ever remove it, and the next try with the same name would say it already exists.
  const discard = async () => {
    await git(top, ['worktree', 'remove', '--force', root]).catch(() => '');
    await removePath(root).catch(() => undefined);
    await git(top, ['worktree', 'prune']).catch(() => '');
  };
  try {
    await git(top, ['worktree', 'add', '--detach', root, sha]);
  } catch (cause) { await discard(); throw cause; }
  // git prints the prefix with `/` and a trailing slash; resolve gives the machine's own separators without it.
  const worker = path.resolve(root, prefix);
  if (!(await stat(worker).then(s => s.isDirectory(), () => false))) {
    await discard();
    throw new Error(`Папки ${prefix} нет в коммите ${sha.slice(0, 12)}: закоммитьте раздел перед запуском исполнителей`);
  }
  return { root, path: worker, sha };
}

/** Removes a copy made by createWorktree; a copy that is already gone counts as removed. */
export async function removeWorktree(input: { basePath: string; root: string }): Promise<{ removed: true }> {
  const root = path.resolve(input.root);
  const inside = path.relative(worktreesRoot(), root);
  // `..demo-1a2b3c4d` (a repository named `..demo`) is inside; only `..` itself or `../…` leaves the folder.
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error(`${root} не копия AI Factory`);
  if (!(await exists(root))) {
    await git(input.basePath, ['worktree', 'prune']).catch(() => '');
    return { removed: true };
  }
  // The copy names its main repository, so a renamed or deleted base folder does not leak it. The removing git runs
  // with --git-dir, not inside the copy: on Windows a git whose folder is the copy cannot delete it (Permission denied).
  const common = await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null);
  if (common) {
    await run('git', ['--git-dir', common, 'worktree', 'remove', '--force', root], { timeout: 120_000 }).catch(async cause => {
      // git may drop the registration and fail on a file it cannot delete; a later retry would get
      // "is not a working tree". Once git no longer knows the folder, it is ours to delete.
      if (await git(root, ['rev-parse', '--git-dir']).then(() => true, () => false)) throw cause;
    });
  } else await git(input.basePath, ['worktree', 'remove', '--force', root]).catch(() => '');
  await removePath(root);
  return { removed: true };
}
