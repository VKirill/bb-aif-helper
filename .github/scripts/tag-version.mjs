import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function packageVersion(cwd) {
  const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
  if (pkg.name !== 'bb-plugin-aif-chat' || typeof pkg.version !== 'string'
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)) {
    throw new Error('Expected bb-plugin-aif-chat with a stable X.Y.Z package version.');
  }
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package.json and package-lock.json versions must match.');
  }
  return pkg.version;
}

export function tagVersion({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_REPOSITORY !== 'ichinya/bb-aif-helper') {
    throw new Error('Version tags are created only for main pushes in ichinya/bb-aif-helper.');
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('Expected the tested commit SHA.');
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  const sha = git(['rev-parse', 'HEAD']);
  if (sha !== env.GITHUB_SHA) throw new Error('Checkout does not match the tested commit.');
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Tagging requires a clean checkout.');
  const tag = `v${packageVersion(cwd)}`;
  const main = git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).split(/\s/)[0];
  if (main !== sha) return { tag, created: false, reason: 'main advanced; this run is stale' };
  const existing = spawnSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`],
    { cwd, encoding: 'utf8', windowsHide: true });
  if (existing.error) throw existing.error;
  if (existing.status === 0) return { tag, created: false, reason: 'version already tagged; bump package.json for another release' };
  if (existing.status !== 2) throw new Error(`Could not check remote tag: ${existing.stderr}`);
  git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'tag', '-a', tag, sha, '-m', `Release ${tag}`]);
  // Only this ref is pushed. Existing remote tags are never moved or deleted.
  git(['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  return { tag, created: true, reason: `tagged tested commit ${sha}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = tagVersion();
    const message = `${result.created ? 'Created' : 'Skipped'} ${result.tag}: ${result.reason}`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
