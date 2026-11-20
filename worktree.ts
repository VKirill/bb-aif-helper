import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Copies for parallel /aif-implement workers. The base folder may be a project root, a section folder with its
// own repository, or a subfolder of a larger repository: the copy forks the whole repository and the worker's
// folder is the same subfolder inside it. BB core forks only a project root that is itself a git checkout.

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await run('git', ['-C', cwd, ...args], { timeout: 120_000, maxBuffer: 4 << 20 })).stdout.trim();
const exists = (p: string) => stat(p).then(() => true, () => false);

/** Every copy lives here, so removal never touches a folder this plugin did not make. */
export const worktreesRoot = () => path.join(homedir(), '.bb-aif-helper', 'worktrees');
export const WORKTREE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

export type CreatedWorktree = { root: string; path: string; sha: string };

export async function createWorktree(input: { basePath: string; name: string; ref?: string }): Promise<CreatedWorktree> {
  if (!WORKTREE_NAME.test(input.name)) throw new Error(`Недопустимое имя копии: ${input.name}`);
  const top = await git(input.basePath, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new Error(`${input.basePath} не в git-репозитории`);
  });
  const prefix = await git(input.basePath, ['rev-parse', '--show-prefix']);
  const sha = await git(top, ['rev-parse', '--verify', `${input.ref || 'HEAD'}^{commit}`]);
  const repoKey = `${path.basename(top)}-${createHash('sha256').update(top).digest('hex').slice(0, 8)}`;
  const root = path.join(worktreesRoot(), repoKey, input.name);
  if (await exists(root)) throw new Error(`Копия ${root} уже существует`);
  await mkdir(path.dirname(root), { recursive: true });
  await git(top, ['worktree', 'add', '--detach', root, sha]);
  return { root, path: prefix ? path.join(root, prefix).replace(/\/+$/, '') : root, sha };
}

/** Removes a copy made by createWorktree; a copy that is already gone counts as removed. */
export async function removeWorktree(input: { basePath: string; root: string }): Promise<{ removed: true }> {
  const root = path.resolve(input.root);
  if (!root.startsWith(worktreesRoot() + path.sep)) throw new Error(`${root} не копия AI Factory`);
  if (await exists(root)) await git(root, ['worktree', 'remove', '--force', root]);
  else await git(input.basePath, ['worktree', 'prune']).catch(() => '');
  return { removed: true };
}
