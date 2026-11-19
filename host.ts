import { stat } from 'node:fs/promises';
import path from 'node:path';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk';
import { hostContract, hostSignals } from './contract.ts';
import { collectSnapshot, readPlanText } from './reader.ts';
import { readDelegation, writeDelegation } from './delegation.ts';
import { WATCH_IGNORED, relevantChange } from './live-updates.ts';

type Subscription = { dispose(): Promise<void> };
const watches = new Map<string, Subscription[]>();
const disposeAll = (subs: Subscription[] | undefined) => Promise.all((subs ?? []).map(sub => sub.dispose().catch(() => {})));
// BB shares one native watcher per directory: when BB's own workspace watcher on the same root
// skips a git-ignored .ai-factory/, a root subscription never sees changes there. A second
// subscription rooted at .ai-factory/ itself does.
const SEPARATE_DIRS = ['.ai-factory'];

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    collect: (input, context) => collectSnapshot(input, context.signal),
    delegation: input => readDelegation(input.root),
    setDelegation: input => writeDelegation(input.root, input.choice, input.role),
    planText: input => readPlanText(input.root, input.target),
    watch: async (input, context) => {
      const root = input.root;
      if (watches.has(root)) return { ok: true as const };
      const listener = async (event: Parameters<Parameters<typeof context.experimental_watch>[1]>[0], base: string) => {
        try {
            if (event.kind === 'changed') {
              const relevant = event.changes.some(change => {
                const rel = path.isAbsolute(change.path) ? path.relative(root, change.path) : path.join(path.relative(root, base), change.path);
                return relevantChange(rel);
              });
              if (relevant) await context.experimental_emitSignal('filesChanged', { root });
            } else if (event.kind === 'rescan-required') {
              await context.experimental_emitSignal('filesChanged', { root });
            } else {
              const current = watches.get(root);
              watches.delete(root);
              await disposeAll(current);
              await context.experimental_emitSignal('watchLost', { root, reason: event.message.slice(0, 500) });
            }
          } catch { /* signal delivery must not escape the watcher listener */ }
      };
      const options = { debounceMs: 300, maxWaitMs: 1000 };
      const subs: Subscription[] = [await context.experimental_watch({ rootPath: root, ignoredPaths: WATCH_IGNORED, ...options }, event => listener(event, root))];
      try {
        for (const dir of SEPARATE_DIRS) {
          const full = path.join(root, dir);
          const isDir = await stat(full).then(st => st.isDirectory(), () => false);
          if (isDir) subs.push(await context.experimental_watch({ rootPath: full, ...options }, event => listener(event, full)));
        }
      } catch (error) { await disposeAll(subs); throw error; }
      watches.set(root, subs);
      return { ok: true as const };
    },
    unwatch: async input => {
      const current = watches.get(input.root);
      if (current) {
        watches.delete(input.root);
        await disposeAll(current);
      }
      return { ok: true as const };
    },
  },
  dispose: async () => {
    const pending = [...watches.values()];
    watches.clear();
    await Promise.all(pending.map(disposeAll));
  },
});
