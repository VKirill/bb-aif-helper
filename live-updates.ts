// RPC live-update tags: these are the only tag strings the plugin uses.
// The server marks them stale with bb.rpc.experimental_invalidate;
// the UI subscribes to reads through experimental_useRpcQuery.
export const threadTag = (threadId: string) => `thread:${threadId}`;
export const projectTag = (projectId: string) => `project:${projectId}`;
export const CHIP_SCORING_TAG = 'chip-scoring';

// Heavy directories the host watcher skips entirely.
export const WATCH_IGNORED = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.bb'];

// A change is relevant when it can alter what the snapshot reads: dot entries
// at the root (.ai-factory/, .github/, .ai-factory.json), root docs with a
// doc/config extension or a build-file name, and everything under docs/ and
// openspec/. Source files are not relevant.
export function relevantChange(input: string): boolean {
  const p = input.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!p || p === '..' || p.startsWith('../')) return false;
  const first = p.split('/')[0]!;
  if (p.startsWith('docs/') || p.startsWith('openspec/')) return true;
  if (first.startsWith('.') && !WATCH_IGNORED.includes(first)) return true;
  if (p.includes('/')) return false;
  const name = p.toLowerCase();
  return /\.(md|ya?ml|json|toml)$/.test(name)
    || ['makefile', 'dockerfile', 'jenkinsfile', 'justfile'].includes(name)
    || name.startsWith('taskfile.');
}
