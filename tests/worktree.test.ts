import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorktree, removeWorktree, worktreesRoot } from '../worktree.ts';
import { bringBack, checkpoint, listChanges } from '../parallel-git.ts';

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
  sh(odd, 'add', '-A'); sh(odd, 'commit', '-qm', 'rename');
  // Two launches with one name: exactly one copy, and the losing launch does not remove the winner's.
  const results = await Promise.allSettled([1, 2].map(() => createWorktree({ basePath: path.join(odd, 'sec-renamed'), name: 'race' })));
  const won = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ root: string; path: string }>[];
  assert.equal(won.length, 1, JSON.stringify(results.map(r => r.status === "rejected" ? String(r.reason) : "ok")));
  assert.equal(existsSync(path.join(won[0].value.path, 'a.txt')), true);
  // A copy deleted without git, while its base folder was renamed, does not block the next launch with that name.
  rmSync(won[0].value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  // Windows may finish a delete a while after rmSync returns, while a scanner or indexer still holds a handle.
  for (let i = 0; i < 300 && existsSync(won[0].value.root); i++) await new Promise(resolve => setTimeout(resolve, 100));
  const again = await createWorktree({ basePath: path.join(odd, 'sec-renamed'), name: 'race' });
  await removeWorktree({ basePath: path.join(odd, 'sec-renamed'), root: again.root });
});

test('bringing results back: a conflicting patch changes nothing and earlier results survive', async () => {
  const top = path.join(sandbox, 'apply-repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(top, 'sec'), { recursive: true });
  writeFileSync(path.join(top, 'sec', 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(top, 'sec', 'b.txt'), 'b\n');
  // Same contents at the root: with diff.relative a patch made in `sec/` would name the root file instead.
  writeFileSync(path.join(top, 'a.txt'), 'one\ntwo\nthree\n');
  sh(top, 'init', '-q'); sh(top, 'config', 'diff.relative', 'true'); sh(top, 'config', 'diff.noprefix', 'true'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'sec');
  const sha = sh(top, 'rev-parse', 'HEAD');
  const [one, two] = [await createWorktree({ basePath: base, name: 'apply-1', ref: sha }), await createWorktree({ basePath: base, name: 'apply-2', ref: sha })];
  writeFileSync(path.join(one.path, 'a.txt'), 'one\nTASK1\nthree\n');
  writeFileSync(path.join(one.path, 'logo.bin'), Buffer.from([0, 255, 1, 254, 0]));
  writeFileSync(path.join(two.path, 'a.txt'), 'one\nTASK2\nthree\n');
  writeFileSync(path.join(two.path, 'b.txt'), 'b changed\n');
  writeFileSync(path.join(two.path, 'new.txt'), 'new\n');
  // The worker's copy refreshed the plugin's own blocks: that change must not travel, or it would collide.
  mkdirSync(path.join(one.path, '.ai-factory', 'skill-context'), { recursive: true });
  writeFileSync(path.join(one.path, '.ai-factory', 'skill-context', 'own.md'), 'refreshed\n');
  assert.deepEqual((await bringBack({ root: base, copy: one.path })).applied, true);
  assert.equal(existsSync(path.join(base, '.ai-factory')), false, 'the plugin\'s own blocks stay out of the patch');
  assert.equal(text(path.join(base, 'a.txt')), 'one\nTASK1\nthree\n');
  assert.equal(text(path.join(top, 'a.txt')), 'one\ntwo\nthree\n', 'the root file with the same contents is untouched');
  assert.deepEqual([...readFileSync(path.join(base, 'logo.bin'))], [0, 255, 1, 254, 0]);
  const snapshot = () => [sh(top, 'status', '--porcelain=v1', '-uall'), sh(top, 'ls-files', '-s'), sh(top, 'diff', '--binary'),
    readFileSync(path.join(base, 'a.txt'), 'utf8'), readFileSync(path.join(base, 'b.txt'), 'utf8')];
  const before = snapshot();
  const refused = await bringBack({ root: base, copy: two.path });
  assert.equal(refused.applied, false);
  assert.match(refused.error ?? '', /patch does not apply|patch failed/);
  assert.deepEqual(snapshot(), before);
  assert.equal(sh(top, 'diff', '--name-only', '--diff-filter=U'), '');
  assert.equal(existsSync(path.join(base, 'new.txt')), false);
  for (const made of [one, two]) await removeWorktree({ basePath: base, root: made.root });
  assert.equal(existsSync(one.root) || existsSync(two.root), false);
});

test('bring-back carries renames, deletions and awkward names, and refuses a folder that is not a copy', async () => {
  const top = path.join(sandbox, 'names repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(top, 'раздел'), { recursive: true });
  writeFileSync(path.join(top, 'раздел', 'old.txt'), 'old\n');
  writeFileSync(path.join(top, 'раздел', 'gone.txt'), 'gone\n');
  sh(top, 'init', '-q'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  const base = path.join(top, 'раздел');
  const copy = await createWorktree({ basePath: base, name: 'names-1' });
  sh(copy.path, 'mv', 'old.txt', 'new name.txt');
  rmSync(path.join(copy.path, 'gone.txt'));
  writeFileSync(path.join(copy.path, 'todo[1].txt'), 'bracket\n');
  writeFileSync(path.join(copy.path, "it's \"quoted\" тест.txt"), 'q\n');
  const result = await bringBack({ root: base, copy: copy.path });
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.equal(existsSync(path.join(base, 'old.txt')) || existsSync(path.join(base, 'gone.txt')), false);
  for (const f of ['new name.txt', 'todo[1].txt', "it's \"quoted\" тест.txt"]) assert.equal(existsSync(path.join(base, f)), true, f);
  assert.equal((await bringBack({ root: base, copy: copy.path })).applied, false, 'the same patch again does not fit');
  await assert.rejects(bringBack({ root: base, copy: top }), /не копия AI Factory/);
  await removeWorktree({ basePath: base, root: copy.root });
});

test('checkpoint lists each file, commits exactly the listed ones and refuses after a later change', async () => {
  const top = path.join(sandbox, 'checkpoint repo');
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
  mkdirSync(path.join(top, 'sec', '.ai-factory', 'skill-context'), { recursive: true });
  writeFileSync(path.join(top, 'sec', 'old.txt'), 'old\n');
  writeFileSync(path.join(top, 'sec', 'gone.txt'), 'gone\n');
  writeFileSync(path.join(top, 'sec', '.ai-factory', 'skill-context', 'own.md'), 'v1\n');
  writeFileSync(path.join(top, 'outside.txt'), 'outside\n');
  sh(top, 'init', '-q'); sh(top, 'add', '-A'); sh(top, 'commit', '-qm', 'init');
  sh(top, 'config', 'user.email', 't@t'); sh(top, 'config', 'user.name', 't');
  const root = path.join(top, 'sec');
  sh(top, 'mv', 'sec/old.txt', 'sec/renamed.txt');
  rmSync(path.join(root, 'gone.txt'));
  mkdirSync(path.join(root, 'new dir'));
  writeFileSync(path.join(root, 'new dir', 'тест.txt'), 'mine\n');
  writeFileSync(path.join(root, 'todo[1].txt'), 'mine\n');
  writeFileSync(path.join(root, 'todo1.txt'), 'not listed later\n');
  writeFileSync(path.join(root, '.ai-factory', 'skill-context', 'own.md'), 'v2\n');
  writeFileSync(path.join(top, 'outside.txt'), 'outside changed\n');
  const listed = await listChanges({ root });
  // One entry per file (a new folder is not collapsed to `new dir/`), the plugin's blocks and other sections left out.
  assert.deepEqual(listed.files.map(f => f.path), ['sec/gone.txt', 'sec/new dir/тест.txt', 'sec/old.txt', 'sec/renamed.txt', 'sec/todo1.txt', 'sec/todo[1].txt']);
  writeFileSync(path.join(root, 'todo[1].txt'), 'edited after the list\n');
  await assert.rejects(checkpoint({ root, token: listed.token, message: 'cp' }), /поменялись после проверки/);
  rmSync(path.join(root, 'todo1.txt'));
  const again = await listChanges({ root });
  const done = await checkpoint({ root, token: again.token, message: 'chore(aif): plan · before group 2' });
  assert.equal(done.committed, true);
  assert.deepEqual(sh(top, '-c', 'core.quotepath=false', 'show', '--name-status', '--format=', 'HEAD').split('\n').sort(),
    ['A\tsec/new dir/тест.txt', 'A\tsec/todo[1].txt', 'D\tsec/gone.txt', 'R100\tsec/old.txt\tsec/renamed.txt'].sort());
  assert.deepEqual(sh(top, 'status', '--porcelain').split('\n').map(l => l.trim()).sort(), ['M outside.txt', 'M sec/.ai-factory/skill-context/own.md'], 'other sections and the plugin\'s blocks stay uncommitted');
  const empty = await listChanges({ root });
  assert.deepEqual(empty.files, []);
  assert.deepEqual(await checkpoint({ root, token: empty.token, message: 'cp' }), { committed: false, files: [] });
});
