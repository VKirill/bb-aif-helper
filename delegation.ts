import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// Code delegation: /aif-implement hands each plan task to a BB thread on the
// model the owner picked in the panel. `.ai-factory.json` → phases.implement is
// the single source of truth (AI Factory's own dispatch config); the
// skill-context block is a managed copy derived from it. Workers are spawned
// with native `bb thread` commands described in that block — no project script.

export const CONTEXT_PATH = '.ai-factory/skill-context/aif-implement/SKILL.md';
const START = '<!-- bb-aif-helper:delegation:start -->';
const END = '<!-- bb-aif-helper:delegation:end -->';
// Research: every AI Factory skill reads the global skill-context, so Explore-style
// subagents of /aif-plan, /aif-fix, /aif-qa… run as BB threads on the chosen model.
// The block itself is the source of truth: its first lines record the model spec
// of each of the three research workers (the /aif-plan Explore agents 1-3).
export const RESEARCH_PATH = '.ai-factory/skill-context/global-skill-context.md';
const RESEARCH_START = '<!-- bb-aif-helper:research:start -->';
const RESEARCH_END = '<!-- bb-aif-helper:research:end -->';
export const RESEARCH_ROLES = ['research', 'research2', 'research3'] as const;
export type ResearchRole = typeof RESEARCH_ROLES[number];
const RESEARCH_MARK: Record<ResearchRole, string> = { research: 'research-model', research2: 'research-model-2', research3: 'research-model-3' };
export const delegationRoleSchema = z.enum(['implement', ...RESEARCH_ROLES]);
export type DelegationRole = z.infer<typeof delegationRoleSchema>;
const AGENT = 'bb';
const TIMEOUT_MS = 4 * 60 * 60 * 1000;

const id = z.string().regex(/^[\w.-]{1,100}$/);
export const delegationChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('self') }).strict(),
  z.object({ mode: z.literal('bb'), providerId: id, model: z.string().regex(/^[^\s?&#]{1,200}$/), reasoning: id.optional(), tier: id.optional() }).strict(),
]);
export type DelegationChoice = z.infer<typeof delegationChoiceSchema>;
export const delegationStateSchema = z.object({
  choice: delegationChoiceSchema,
  /** Model for research worker 1 (Explore) of every AI Factory skill; self = the agent's own subagent. */
  research: delegationChoiceSchema,
  /** Research workers 2 and 3; self = same as worker 1. */
  research2: delegationChoiceSchema,
  research3: delegationChoiceSchema,
  configured: z.boolean(),
  // phases.implement points at an agent this plugin does not manage.
  foreign: z.string().nullable(),
  error: z.string().nullable(),
  // Set only on the setDelegation response when legacy runner files were removed.
  removedLegacy: z.boolean().optional(),
});
export type DelegationState = z.infer<typeof delegationStateSchema>;

// AI Factory keeps only agent/model/timeoutMs of a phase, so the whole BB
// selection lives in `model`: provider/model?reasoning=high&tier=fast.
// The model part may itself contain "/" or ":" (OpenRouter, Ollama ids).
export function modelSpec(c: Extract<DelegationChoice, { mode: 'bb' }>) {
  const query = [c.reasoning && `reasoning=${c.reasoning}`, c.tier && `tier=${c.tier}`].filter(Boolean).join('&');
  return `${c.providerId}/${c.model}${query ? `?${query}` : ''}`;
}
export function parseSpec(value: unknown): DelegationChoice | null {
  const m = typeof value === 'string' ? /^([\w.-]{1,100})\/([^\s?&#]{1,200})(?:\?([\w.=&-]{1,200}))?$/.exec(value) : null;
  if (!m) return null;
  const params = new URLSearchParams(m[3] ?? '');
  const reasoning = params.get('reasoning'), tier = params.get('tier');
  const ok = (v: string | null) => v === null || /^[\w.-]{1,100}$/.test(v);
  if (!ok(reasoning) || !ok(tier)) return null;
  return { mode: 'bb', providerId: m[1], model: m[2], ...(reasoning ? { reasoning } : {}), ...(tier ? { tier } : {}) };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

async function readConfig(root: string): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, '.ai-factory.json'), 'utf8'));
    if (!isObject(parsed)) throw new Error('.ai-factory.json is not an object');
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function readText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}

export type ResearchSlots = Record<ResearchRole, DelegationChoice>;
const selfSlots = (): ResearchSlots => ({ research: { mode: 'self' }, research2: { mode: 'self' }, research3: { mode: 'self' } });

/** The research choices recorded in the managed block of the global skill-context; self when absent or malformed. */
export function parseResearch(text: string): ResearchSlots {
  const slots = selfSlots();
  const start = text.indexOf(RESEARCH_START), end = text.indexOf(RESEARCH_END);
  if (start < 0 || end < start) return slots;
  const block = text.slice(start, end);
  for (const role of RESEARCH_ROLES) {
    const spec = new RegExp(`<!-- ${RESEARCH_MARK[role]}: (\\S{1,400}) -->`).exec(block)?.[1];
    slots[role] = parseSpec(spec) ?? { mode: 'self' };
  }
  return slots;
}

export async function readDelegation(root: string): Promise<DelegationState> {
  let research = selfSlots();
  try { research = parseResearch(await readText(join(root, RESEARCH_PATH))); } catch { /* unreadable context: research stays self */ }
  const base = await readImplement(root);
  return { ...base, ...research };
}

async function readImplement(root: string): Promise<Omit<DelegationState, ResearchRole>> {
  let config: Json | null;
  try { config = await readConfig(root); } catch (e) {
    return { choice: { mode: 'self' }, configured: false, foreign: null, error: `Не читается .ai-factory.json: ${(e as Error).message.slice(0, 200)}` };
  }
  if (!config) return { choice: { mode: 'self' }, configured: false, foreign: null, error: null };
  const phase = isObject(config.phases) && isObject(config.phases.implement) ? config.phases.implement : null;
  if (!phase) return { choice: { mode: 'self' }, configured: true, foreign: null, error: null };
  if (phase.agent !== AGENT) return { choice: { mode: 'self' }, configured: true, foreign: String(phase.agent ?? 'unknown'), error: null };
  const choice = parseSpec(phase.model);
  return choice
    ? { choice, configured: true, foreign: null, error: null }
    : { choice: { mode: 'self' }, configured: true, foreign: null, error: `phases.implement.model не в формате provider/model?reasoning=…&tier=…: ${String(phase.model).slice(0, 100)}` };
}

async function writeAtomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

/** Replace or remove the managed block; text outside the markers is the owner's. */
export function mergeContextBlock(existing: string, block: string | null, start_ = START, end_ = END): string {
  const start = existing.indexOf(start_);
  const end = existing.indexOf(end_);
  const outside = start >= 0 && end > start ? existing.slice(0, start) + existing.slice(end + end_.length) : existing;
  const rest = outside.replace(/\n{3,}/g, '\n\n').trim();
  if (!block) return rest ? rest + '\n' : '';
  return `${rest ? rest + '\n\n' : ''}${start_}\n${block.trim()}\n${end_}\n`;
}

// parseSpec lets ', ", $, ` and ; through the model id; the block embeds the
// values in shell commands, so every substitution is single-quoted.
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const spawnFlags = (c: Extract<DelegationChoice, { mode: 'bb' }>) => [
  `--provider ${shellQuote(c.providerId)}`,
  `--model ${shellQuote(c.model)}`,
  ...(c.reasoning ? [`--reasoning-level ${shellQuote(c.reasoning)}`] : []),
  ...(c.tier && c.tier !== 'default' ? [`--service-tier ${shellQuote(c.tier)}`] : []),
].join(' ');

type BbChoice = Extract<DelegationChoice, { mode: 'bb' }>;
const workerText: Record<ResearchRole, string> = {
  research: 'Research worker 1 — the first or only research subagent (in /aif-plan: architecture & affected modules)',
  research2: 'Research worker 2 — the second subagent (in /aif-plan: existing patterns & conventions)',
  research3: 'Research worker 3 — the third and any further subagents (in /aif-plan: dependencies & integration points)',
};

/** Managed block for the three research workers; null when every worker stays the agent's own subagent. Workers 2 and 3 fall back to worker 1. */
export function researchBlock(slots: ResearchSlots): string | null {
  const effective = (role: ResearchRole): DelegationChoice => slots[role].mode === 'bb' ? slots[role] : slots.research;
  if (!RESEARCH_ROLES.some(r => effective(r).mode === 'bb')) return null;
  const marks = RESEARCH_ROLES.flatMap(r => { const c = slots[r]; return c.mode === 'bb' ? [`<!-- ${RESEARCH_MARK[r]}: ${modelSpec(c)} -->`] : []; });
  const lines = RESEARCH_ROLES.map(r => { const c = effective(r);
    return `- ${workerText[r]}: ${c.mode === 'bb' ? `\`${modelSpec(c)}\` → spawn flags \`${spawnFlags(c as BbChoice)}\`` : 'your own native subagent, exactly as the skill says'}`; });
  return `${marks.join('\n')}
## Research delegation (managed by BB AIF Helper)

The project owner chose models (BB provider/model?reasoning&tier) for research subagents. Whenever an AI Factory skill tells you to launch exploration or research subagents — for example \`Task(subagent_type: Explore, …)\` in /aif-plan, /aif-fix or /aif-qa — or you would use your own native subagents for read-only codebase research, number them in the order the skill lists them and run each one as assigned below. Ignore any model the skill names for those subagents.

${lines.join('\n')}

For each worker on a BB model:

1. Write its research prompt to its own temporary file. It starts with these rules (replace \`<thread-id>\` with your own \`BB_THREAD_ID\`), then gives the exact question, the paths to look at and the thoroughness the skill asked for:

\`\`\`
You are a read-only research worker for an AI Factory skill run by BB thread <thread-id>.
Investigate the current workspace and answer the question below. Do not create, edit or delete files, do not commit, and do not start AI Factory skills.
Finish with a concise structured report: the relevant files and symbols with paths, the patterns and integration points you found, and open questions. No full file contents.
\`\`\`

2. Spawn all research workers at once — they only read, so they may run in parallel — with that worker's spawn flags, and take each thread id from the JSON answer:

\`\`\`bash
bb thread spawn --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --parent-notifications off <spawn flags> --title 'AIF research · <skill> · <topic>' --prompt-file <prompt> --json
\`\`\`

3. Wait for each: \`bb thread wait <id> --status idle --timeout 8m\`, repeating while it still works. The report is \`bb thread output <id>\`.
4. Use the reports exactly as the skill uses its subagent results and continue the skill. Its rules on artifacts, questions and approvals do not change.

If \`bb thread spawn\` fails, say so and do that research yourself; do not repeat the same error. Use no \`node\` commands in this flow.`;
}

export function contextBlock(c: Extract<DelegationChoice, { mode: 'bb' }>) {
  const flags = spawnFlags(c);
  return `## Code delegation (managed by BB AIF Helper)

The project owner chose \`${modelSpec(c)}\` (BB provider/model?reasoning&tier) to write the code of plan tasks. The source of truth is \`.ai-factory.json\` → \`phases.implement\`; re-read it before each task. If it no longer has \`"agent": "bb"\`, implement tasks yourself as usual.

You stay the coordinator: you own the plan, its checkboxes, verification and commits. For each plan task, instead of editing the code yourself:

1. Write the task brief to a temporary file. It starts with the worker rules below, then gives the plan path, the task id and its full text, the relevant files and project rules, the verification commands, and what done means for this task.

The worker rules — the mandatory start of every brief (replace \`<thread-id>\` with your own \`BB_THREAD_ID\`):

\`\`\`
You are an implementation worker delegated by an AI Factory /aif-implement coordinator (BB thread <thread-id>).
Do exactly the one task below in the current workspace. Do not edit the plan file or its checkboxes, do not commit, push or switch branches, and do not start AI Factory skills.
Run the verification commands the task names. Finish with a short report: what changed, the files you touched, the checks you ran with their results, and anything left open.
\`\`\`

2. Deduplicate: run \`bb thread list --parent-thread "$BB_THREAD_ID" --json\`. If a non-archived thread has \`title\` = \`AIF · <plan> · <taskId>\`, take its id and go to step 4.
3. Spawn the worker and take the thread id from the JSON answer:

\`\`\`bash
bb thread spawn --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --parent-notifications off ${flags} --title 'AIF · <plan> · <taskId>' --prompt-file <brief> --json
\`\`\`

4. Wait: \`bb thread wait <id> --status idle --timeout 8m\`, repeating while the thread still works. The report is \`bb thread output <id>\`.
5. Review \`git diff\` and run the task's verification yourself. Fix a small gap yourself, or send \`bb thread tell <id> '<what to fix>'\` and wait again (step 4).
6. Only after that mark the task done in the plan and move to the next task. One worker at a time: workers share this workspace.

If \`bb thread spawn\` returns an error, report it and implement that task yourself; do not repeat the same error. Use no \`node\` commands in this flow.`;
}

export async function writeDelegation(root: string, choice: DelegationChoice, role: DelegationRole = 'implement'): Promise<DelegationState> {
  const config = await readConfig(root);
  if (!config) throw new Error('В проекте нет .ai-factory.json: сначала установите AI Factory.');
  if (role !== 'implement') {
    const file = join(root, RESEARCH_PATH);
    const text = await readText(file);
    const next = mergeContextBlock(text, researchBlock({ ...parseResearch(text), [role]: choice }), RESEARCH_START, RESEARCH_END);
    if (next) await writeAtomic(file, next); else await rm(file, { force: true });
    return readDelegation(root);
  }
  const phases: Json = isObject(config.phases) ? { ...config.phases } : {};
  const agents: Json = isObject(config.dispatchAgents) ? { ...config.dispatchAgents } : {};
  const current = isObject(phases.implement) ? phases.implement : null;
  if (current && current.agent !== AGENT) throw new Error(`phases.implement уже настроен на агента «${String(current.agent)}». Измените его вручную в .ai-factory.json.`);
  if (choice.mode === 'bb') phases.implement = { agent: AGENT, model: modelSpec(choice), timeoutMs: TIMEOUT_MS };
  else delete phases.implement;
  // The runner script and its dispatchAgents entry belonged to the previous
  // delegation scheme; `dispatch` stays only while other phases may use it.
  delete agents[AGENT];
  if (Object.keys(phases).length) config.phases = phases; else delete config.phases;
  if (Object.keys(agents).length) config.dispatchAgents = agents; else delete config.dispatchAgents;
  if (!Object.keys(phases).some((key) => key !== 'implement')) delete config.dispatch;
  const contextFile = join(root, CONTEXT_PATH);
  let context = '';
  try { context = await readFile(contextFile, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const nextContext = mergeContextBlock(context, choice.mode === 'bb' ? contextBlock(choice) : null);
  if (nextContext) await writeAtomic(contextFile, nextContext); else await rm(contextFile, { force: true });
  let removedLegacy = false;
  try { await rm(join(root, '.ai-factory/bin/bb-aif-run.mjs')); removedLegacy = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await writeAtomic(join(root, '.ai-factory.json'), JSON.stringify(config, null, 2) + '\n');
  const state = await readDelegation(root);
  return removedLegacy ? { ...state, removedLegacy } : state;
}
