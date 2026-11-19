import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageVersion, tagVersion } from '../.github/scripts/tag-version.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aif-tag-test-'));
  const cwd = path.join(root, 'checkout'); const remote = path.join(root, 'origin.git');
  await fs.mkdir(cwd);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--bare', '--quiet', remote]); git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['remote', 'add', 'origin', remote]);
  async function version(value = '0.8.5') {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'bb-plugin-aif-chat', version: value }));
    await fs.writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify({ version: value, packages: { '': { version: value } } }));
  }
  function commit() { git(['add', '.']); git(['commit', '--quiet', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); }
  await version(); const sha = commit(); git(['push', '--quiet', 'origin', 'main']);
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'ichinya/bb-aif-helper', GITHUB_SHA: sha };
  return { cwd, remote, git, env, version, commit, async cleanup() {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aif-tag-test-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(resolved, { recursive: true, force: true });
  } };
}

test('autotag pushes only one annotated tag for the tested commit and reruns never move it', async () => {
  const f = await fixture(); try {
    const first = tagVersion(f); assert.equal(first.created, true); assert.equal(first.tag, 'v0.8.5');
    assert.equal(f.git(['cat-file', '-t', 'refs/tags/v0.8.5']), 'tag');
    assert.equal(f.git(['--git-dir', f.remote, 'rev-parse', 'v0.8.5^{}']), f.env.GITHUB_SHA);
    assert.equal(tagVersion(f).created, false);
    await fs.writeFile(path.join(f.cwd, 'later.txt'), 'Later change'); f.env.GITHUB_SHA = f.commit(); f.git(['push', '--quiet', 'origin', 'main']);
    assert.equal(tagVersion(f).created, false);
    assert.notEqual(f.git(['--git-dir', f.remote, 'rev-parse', 'v0.8.5^{}']), f.env.GITHUB_SHA);
    await f.version('0.8.6'); f.env.GITHUB_SHA = f.commit(); f.git(['push', '--quiet', 'origin', 'main']);
    assert.equal(tagVersion(f).tag, 'v0.8.6');
    assert.equal(f.git(['--git-dir', f.remote, 'rev-parse', 'v0.8.6^{}']), f.env.GITHUB_SHA);
  } finally { await f.cleanup(); }
});

test('PRs, forks, other refs, wrong commits, dirty files and stale main cannot create tags', async () => {
  const f = await fixture(); try {
    for (const patch of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY: 'someone/fork' },
      { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_SHA: '0'.repeat(40) }]) {
      assert.throws(() => tagVersion({ cwd: f.cwd, env: { ...f.env, ...patch } }));
    }
    await fs.writeFile(path.join(f.cwd, 'dirty.txt'), 'Pending');
    assert.throws(() => tagVersion(f), /clean checkout/);
    const previous = f.env.GITHUB_SHA; f.env.GITHUB_SHA = f.commit(); f.git(['push', '--quiet', 'origin', 'main']);
    f.git(['checkout', '--quiet', previous]); f.env.GITHUB_SHA = previous;
    assert.match(tagVersion(f).reason, /stale/);
    assert.equal(f.git(['ls-remote', '--tags', 'origin']), '');
  } finally { await f.cleanup(); }
});

test('autotag rejects invalid or inconsistent package versions and remote lookup failures', async () => {
  const f = await fixture(); try {
    for (const value of ['01.2.3', '0.8.6-rc.1', 'v0.8.6', '0.8.6; shell']) {
      await f.version(value); assert.throws(() => packageVersion(f.cwd), /stable/);
    }
    await f.version();
    await fs.writeFile(path.join(f.cwd, 'package-lock.json'), '{"version":"0.8.4"}');
    assert.throws(() => packageVersion(f.cwd), /must match/);
    f.git(['checkout', '--', '.']);
    f.git(['remote', 'set-url', 'origin', path.join(f.cwd, 'missing.git')]);
    assert.throws(() => tagVersion(f));
    assert.equal(f.git(['tag', '--list']), '');
  } finally { await f.cleanup(); }
});
