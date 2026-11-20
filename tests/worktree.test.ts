import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorktree, removeWorktree, worktreesRoot } from '../worktree.ts';
import { contextBlock } from '../delegation.ts';

const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'aif-wt-')));
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
process.env.HOME = process.env.USERPROFILE = path.join(sandbox, 'home');
const repo = path.join(sandbox, 'repo');
// Windows runners check out with core.autocrlf=true; the flow must work with it, so text is compared without CR.
const text = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
mkdirSync(path.join(repo, 'plugins', 'section'), { recursive: true });
writeFileSync(path.join(repo, 'plugins', 'section', 'a.txt'), 'A\n');
git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');

test('a section inside a larger repository gets a copy of the repository and its own subfolder', async () => {
  const made = await createWorktree({ basePath: path.join(repo, 'plugins', 'section'), name: 'plan-1' });
  assert(made.root.startsWith(worktreesRoot() + path.sep));
  // No trailing separator on any OS: git prints the prefix as `plugins/section/`.
  assert.equal(made.path, path.join(made.root, 'plugins', 'section'));
  assert.ok(!/[\\/]$/.test(made.path), made.path);
  assert.equal(text(path.join(made.path, 'a.txt')), 'A\n');
  assert.equal(made.sha, git('rev-parse', 'HEAD'));
  await assert.rejects(createWorktree({ basePath: repo, name: 'plan-1' }), /уже существует/);
  assert.deepEqual(await removeWorktree({ basePath: repo, root: made.root }), { removed: true });
  assert.equal(existsSync(made.root), false);
  assert.deepEqual(await removeWorktree({ basePath: repo, root: made.root }), { removed: true });
});

test('a repository root is copied at the requested commit; foreign folders and bad names are refused', async () => {
  const first = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'b.txt'), 'B\n');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'b');
  const made = await createWorktree({ basePath: repo, name: 'plan-2', ref: first });
  assert.equal(made.path, made.root);
  assert.equal(existsSync(path.join(made.path, 'b.txt')), false);
  await removeWorktree({ basePath: repo, root: made.root });
  await assert.rejects(removeWorktree({ basePath: repo, root: repo }), /не копия AI Factory/);
  await assert.rejects(createWorktree({ basePath: repo, name: '../x' }), /Недопустимое имя/);
  await assert.rejects(createWorktree({ basePath: sandbox, name: 'plan-3' }), /не в git-репозитории/);
  await assert.rejects(createWorktree({ basePath: 'repo', name: 'plan-3' }), /абсолютный путь/);
  await assert.rejects(createWorktree({ basePath: repo, name: 'plan-3', ref: '--output=x' }), /Недопустимая ссылка/);
  await assert.rejects(removeWorktree({ basePath: repo, root: worktreesRoot() }), /не копия AI Factory/);
  await assert.rejects(removeWorktree({ basePath: repo, root: path.join(worktreesRoot(), '..', 'x') }), /не копия AI Factory/);
});

test('a copy survives a failing checkout hook cleanly, and is removed even after its base folder is renamed', async () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  // A repository named `..odd`: its copies live in `..odd-<hash>`, which is still inside the copies folder.
  const odd = path.join(sandbox, '..odd');
  mkdirSync(path.join(odd, 'sec'), { recursive: true });
  writeFileSync(path.join(odd, 'sec', 'a.txt'), 'A\n');
  sh(odd, 'init', '-q'); sh(odd, 'add', '-A'); sh(odd, 'commit', '-qm', 'init');
  const hooks = path.join(sandbox, 'hooks'); mkdirSync(hooks, { recursive: true });
  writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  sh(odd, 'config', 'core.hooksPath', hooks);
  await assert.rejects(createWorktree({ basePath: path.join(odd, 'sec'), name: 'hooked' }));
  assert.equal(sh(odd, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1, 'no copy stays registered');
  sh(odd, 'config', '--unset', 'core.hooksPath');
  const made = await createWorktree({ basePath: path.join(odd, 'sec'), name: 'hooked' });
  // A section that is not in the requested commit yet: no copy is left behind.
  const first = sh(odd, 'rev-parse', 'HEAD');
  mkdirSync(path.join(odd, 'later'));
  writeFileSync(path.join(odd, 'later', 'b.txt'), 'B\n');
  sh(odd, 'add', '-A'); sh(odd, 'commit', '-qm', 'later');
  await assert.rejects(createWorktree({ basePath: path.join(odd, 'later'), name: 'early', ref: first }), /нет в коммите/);
  assert.equal(sh(odd, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 2);
  renameSync(path.join(odd, 'sec'), path.join(odd, 'sec-renamed'));
  await removeWorktree({ basePath: path.join(odd, 'sec'), root: made.root });
  assert.equal(existsSync(made.root), false);
});

// Runs step 6 of the parallel instructions exactly as the coordinator reads them: the same commands, in order.
test('bringing results back: a conflicting patch changes nothing and earlier results survive', async () => {
  const block = contextBlock({ mode: 'bb', providerId: 'codex', model: 'm', parallel: 2 });
  const step = block.slice(block.indexOf('\n6. '), block.indexOf('\n7. '));
  const commands = [...step.matchAll(/^ {3}- `(git -C "<(?:copy|top)>" [^`]+)`$/gm)].map(m => m[1]);
  assert.deepEqual(commands.map(c => c.split(' ').slice(3, 5).join(' ')), ['add -A', 'diff --cached', 'apply --check', 'apply "<patch>"']);
  // Every path placeholder is quoted, so a shell keeps a path with spaces as one argument.
  for (const c of commands) assert.ok(!/(^|[^"])<(copy|top|patch)>/.test(c), c);
  const top = path.join(sandbox, 'apply-repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(top, 'sec'), { recursive: true });
  writeFileSync(path.join(top, 'sec', 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(top, 'sec', 'b.txt'), 'b\n');
  // Same contents at the root: with diff.relative a patch made in `sec/` would name the root file instead.
  writeFileSync(path.join(top, 'a.txt'), 'one\ntwo\nthree\n');
  sh(top, 'init', '-q'); sh(top, 'config', 'diff.relative', 'true'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'sec');
  const sha = sh(top, 'rev-parse', 'HEAD');
  const [one, two] = [await createWorktree({ basePath: base, name: 'apply-1', ref: sha }), await createWorktree({ basePath: base, name: 'apply-2', ref: sha })];
  writeFileSync(path.join(one.path, 'a.txt'), 'one\nTASK1\nthree\n');
  writeFileSync(path.join(one.path, 'logo.bin'), Buffer.from([0, 255, 1, 254, 0]));
  writeFileSync(path.join(two.path, 'a.txt'), 'one\nTASK2\nthree\n');
  writeFileSync(path.join(two.path, 'b.txt'), 'b changed\n');
  writeFileSync(path.join(two.path, 'new.txt'), 'new\n');
  const bringBack = (copy: string, taskId: number) => {
    const patch = path.join(sandbox, `task-${taskId}.patch`);
    for (const command of commands) {
      // Like a shell: split the template on spaces outside double quotes, then put each path in as one value.
      // A replacer function keeps `$&` and other `$` sequences in a path literal.
      const values: Record<string, string> = { '<copy>': copy, '<top>': top, '<patch>': patch };
      const args = command.match(/(?:[^\s"]+|"[^"]*")+/g)!.slice(1)
        .map(arg => arg.replace(/"/g, '').replace(/<copy>|<top>|<patch>/g, key => values[key]));
      execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' });
    }
  };
  bringBack(one.path, 1);
  assert.equal(text(path.join(base, 'a.txt')), 'one\nTASK1\nthree\n');
  assert.equal(text(path.join(top, 'a.txt')), 'one\ntwo\nthree\n', 'the root file with the same contents is untouched');
  assert.deepEqual([...readFileSync(path.join(base, 'logo.bin'))], [0, 255, 1, 254, 0]);
  const snapshot = () => [sh(top, 'status', '--porcelain=v1', '-uall'), sh(top, 'ls-files', '-s'), sh(top, 'diff', '--binary'),
    readFileSync(path.join(base, 'a.txt'), 'utf8'), readFileSync(path.join(base, 'b.txt'), 'utf8')];
  const before = snapshot();
  assert.throws(() => bringBack(two.path, 2), /patch does not apply|patch failed/);
  // Even a plain apply without the check is all-or-nothing: b.txt and new.txt would apply, a.txt would not.
  assert.throws(() => execFileSync('git', ['-C', top, 'apply', path.join(sandbox, 'task-2.patch')], { stdio: 'pipe' }));
  assert.deepEqual(snapshot(), before);
  assert.equal(sh(top, 'diff', '--name-only', '--diff-filter=U'), '');
  assert.equal(existsSync(path.join(base, 'new.txt')), false);
  for (const made of [one, two]) await removeWorktree({ basePath: base, root: made.root });
  assert.equal(existsSync(one.root) || existsSync(two.root), false);
});
