import path from 'node:path';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk';
import { hostContract, hostSignals } from './contract.ts';
import { collectSnapshot, readPlanText } from './reader.ts';
import { readDelegation, writeDelegation } from './delegation.ts';
import { WATCH_IGNORED, relevantChange } from './live-updates.ts';

const watches = new Map<string, { dispose(): Promise<void> }>();

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
      const subscription = await context.experimental_watch(
        { rootPath: root, ignoredPaths: WATCH_IGNORED, debounceMs: 300, maxWaitMs: 1000 },
        async event => {
          try {
            if (event.kind === 'changed') {
              const relevant = event.changes.some(change => {
                const rel = path.isAbsolute(change.path) ? path.relative(root, change.path) : change.path;
                return relevantChange(rel);
              });
              if (relevant) await context.experimental_emitSignal('filesChanged', { root });
            } else if (event.kind === 'rescan-required') {
              await context.experimental_emitSignal('filesChanged', { root });
            } else {
              const current = watches.get(root);
              watches.delete(root);
              await current?.dispose().catch(() => {});
              await context.experimental_emitSignal('watchLost', { root, reason: event.message.slice(0, 500) });
            }
          } catch { /* signal delivery must not escape the watcher listener */ }
        },
      );
      watches.set(root, subscription);
      return { ok: true as const };
    },
    unwatch: async input => {
      const current = watches.get(input.root);
      if (current) {
        watches.delete(input.root);
        await current.dispose();
      }
      return { ok: true as const };
    },
  },
  dispose: async () => {
    const pending = [...watches.values()];
    watches.clear();
    await Promise.all(pending.map(watch => watch.dispose()));
  },
});
