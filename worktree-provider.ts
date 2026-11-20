import { z } from 'zod';

/** Environment provider for parallel /aif-implement workers; BB provider ids are global. */
export const WORKTREE_PROVIDER_ID = 'aif-chat-worktree';

/**
 * `basePath` is the coordinator's folder: a project root, a section with its own repository, or a subfolder of a
 * larger repository. `name` is `<plan>-<taskId>`, `ref` the checkpoint commit the copy starts from (default HEAD).
 */
export const worktreeInputs = z.object({
  basePath: z.string().startsWith('/').max(4096),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
  ref: z.string().max(200).optional(),
}).strict();
const resourceSchema = z.object({ basePath: z.string(), root: z.string() });

type Log = { info(message: string): void; warn(message: string): void };
type HostCall = {
  call(method: 'createWorktree', input: z.infer<typeof worktreeInputs>, options: { hostId: string; signal?: AbortSignal }): Promise<{ root: string; path: string; sha: string }>;
  call(method: 'removeWorktree', input: { basePath: string; root: string }, options: { hostId: string; signal?: AbortSignal }): Promise<{ removed: true }>;
};
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);

/**
 * BB owns the environment row and retires it five minutes after its last thread is archived; this plugin only makes
 * and removes the git copy on the folder's machine. Returns false on a BB without environment providers.
 */
export function registerWorktreeProvider(bb: { log: Log; experimental_environments?: { register?: unknown } }, host: HostCall): boolean {
  const environments = bb.experimental_environments as { register?: (declaration: unknown) => void } | undefined;
  if (typeof environments?.register !== 'function') {
    bb.log.info('aif-chat: this BB has no environment providers; parallel workers use the one-worker flow');
    return false;
  }
  try {
    environments.register({
      id: WORKTREE_PROVIDER_ID,
      displayName: 'AI Factory worktree',
      description: 'A git copy of this folder for one parallel /aif-implement worker. The folder may be a section inside a larger repository.',
      icon: 'FolderGit',
      // Offered only where the project's folder is; the folder itself need not be the repository root.
      requires: { projectCheckout: true },
      inputs: worktreeInputs,
      policy: { pathKeys: 'per-attempt', retireGraceMs: 5 * 60_000 },
      async create(context: { inputs: z.infer<typeof worktreeInputs>; host: { id: string }; signal: AbortSignal; report: { step(text: string): void } }) {
        try {
          context.report.step('Creating the worktree');
          const made = await host.call('createWorktree', context.inputs, { hostId: context.host.id, signal: context.signal });
          bb.log.info(`aif-chat: worktree created name=${context.inputs.name} sha=${made.sha.slice(0, 12)} path=${made.path}`);
          return { status: 'created', path: made.path, ownsPath: true, resource: { basePath: context.inputs.basePath, root: made.root } };
        } catch (cause) {
          if (context.signal.aborted) throw cause;
          bb.log.warn(`aif-chat: worktree create failed name=${context.inputs.name}: ${message(cause)}`);
          return { status: 'failed', message: message(cause) };
        }
      },
      async remove(context: { hostId: string | null; resource: unknown; signal: AbortSignal }) {
        const resource = resourceSchema.safeParse(context.resource);
        // A create that never answered left nothing this plugin knows how to find.
        if (!resource.success) return { status: 'removed' };
        if (context.hostId === null) return { status: 'failed', message: 'The worktree machine is unknown' };
        try {
          await host.call('removeWorktree', resource.data, { hostId: context.hostId, signal: context.signal });
          bb.log.info(`aif-chat: worktree removed root=${resource.data.root}`);
          return { status: 'removed' };
        } catch (cause) {
          if (context.signal.aborted) throw cause;
          bb.log.warn(`aif-chat: worktree remove failed root=${resource.data.root}: ${message(cause)}`);
          return { status: 'failed', message: message(cause) };
        }
      },
    });
  } catch (cause) {
    bb.log.warn(`aif-chat: environment provider ${WORKTREE_PROVIDER_ID} did not register: ${message(cause)}`);
    return false;
  }
  return true;
}
