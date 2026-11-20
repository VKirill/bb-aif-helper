import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { RESEARCH_ROLES } from './model.ts';
import type { DelegationChoice, DelegationRole, DelegationState, ResearchRole } from './model.ts';
export { DELEGATION_ROLES, RESEARCH_ROLES, delegationChoiceSchema, delegationDefaultsSchema, delegationRoleSchema, delegationStateSchema } from './model.ts';
export type { DelegationChoice, DelegationDefaults, DelegationRole, DelegationState, ResearchRole } from './model.ts';

// Code delegation: /aif-implement hands each plan task to a BB thread on the
// model the owner picked in the panel. `.ai-factory.json` → phases.implement is
// the single source of truth (AI Factory's own dispatch config); the
// skill-context block is a managed copy derived from it. Workers are spawned
// with native `bb thread` commands described in that block — no project script.

export const CONTEXT_PATH = '.ai-factory/skill-context/aif-implement/SKILL.md';
const START = '<!-- bb-aif-helper:delegation:start -->';
const END = '<!-- bb-aif-helper:delegation:end -->';
export const PLAN_CONTEXT_PATH = '.ai-factory/skill-context/aif-plan/SKILL.md';
const PLAN_START = '<!-- bb-aif-helper:plan:start -->';
const PLAN_END = '<!-- bb-aif-helper:plan:end -->';
// Research: every AI Factory skill reads the global skill-context, so Explore-style
// subagents of /aif-plan, /aif-fix, /aif-qa… run as BB threads on the chosen model.
// The block itself is the source of truth: its first lines record the model spec
// of each of the three research workers (the /aif-plan Explore agents 1-3).
export const RESEARCH_PATH = '.ai-factory/skill-context/global-skill-context.md';
const RESEARCH_START = '<!-- bb-aif-helper:research:start -->';
const RESEARCH_END = '<!-- bb-aif-helper:research:end -->';
const RESEARCH_MARK: Record<ResearchRole, string> = { research: 'research-model', research2: 'research-model-2', research3: 'research-model-3' };
const AGENT = 'bb';
const TIMEOUT_MS = 4 * 60 * 60 * 1000;

// AI Factory keeps only agent/model/timeoutMs of a phase, so the whole BB
// selection lives in `model`: provider/model?reasoning=high&tier=fast.
// The model part may itself contain "/" or ":" (OpenRouter, Ollama ids).
export function modelSpec(c: Extract<DelegationChoice, { mode: 'bb' }>) {
  const query = [c.reasoning && `reasoning=${c.reasoning}`, c.tier && `tier=${c.tier}`, c.parallel && `parallel=${c.parallel}`].filter(Boolean).join('&');
  return `${c.providerId}/${c.model}${query ? `?${query}` : ''}`;
}
export function parseSpec(value: unknown): DelegationChoice | null {
  const m = typeof value === 'string' ? /^([\w.-]{1,100})\/([^\s?&#]{1,200})(?:\?([\w.=&-]{1,200}))?$/.exec(value) : null;
  if (!m) return null;
  const params = new URLSearchParams(m[3] ?? '');
  const reasoning = params.get('reasoning'), tier = params.get('tier'), parallel = params.get('parallel');
  const ok = (v: string | null) => v === null || /^[\w.-]{1,100}$/.test(v);
  if (!ok(reasoning) || !ok(tier) || (parallel !== null && !/^[2-4]$/.test(parallel))) return null;
  return { mode: 'bb', providerId: m[1], model: m[2], ...(reasoning ? { reasoning } : {}), ...(tier ? { tier } : {}), ...(parallel ? { parallel: Number(parallel) } : {}) };
}

// parallel workers are an implement-only setting: research choices never keep it.
const stripParallel = (c: BbChoice): BbChoice => {
  const { parallel: _p, ...rest } = c;
  return rest;
};

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
    const c = parseSpec(spec);
    slots[role] = c?.mode === 'bb' ? stripParallel(c) : c ?? { mode: 'self' };
  }
  return slots;
}

// Panel reads, status refreshes and saves of one project write the same files; one at a time per folder,
// so a refresh started before a save never puts the old model back after it.
const queues = new Map<string, Promise<unknown>>();
export function serialByRoot<T>(root: string, job: () => Promise<T>): Promise<T> {
  const key = resolve(root); // `/repo` and `/repo/` are one folder
  const next = (queues.get(key) ?? Promise.resolve()).then(job, job);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

export function readDelegation(root: string): Promise<DelegationState> {
  return serialByRoot(root, () => readDelegationNow(root));
}

async function readDelegationNow(root: string): Promise<DelegationState> {
  let research = selfSlots();
  try { research = parseResearch(await readText(join(root, RESEARCH_PATH))); } catch { /* unreadable context: research stays self */ }
  const base = await readImplement(root);
  // Best effort: a folder that cannot be written (read-only checkout, permissions) still answers the read.
  await refreshBlocks(root, base.choice, research).catch(() => undefined);
  return { ...base, ...research };
}

/**
 * The managed blocks are text the agent follows, written when the owner saved the choice. After a plugin update
 * they would keep the old commands (for example `git apply --3way`) until the next save, so every read rewrites a
 * block that differs from what this version generates. Text outside the markers is never touched.
 */
async function refreshBlocks(root: string, choice: DelegationChoice, research: ResearchSlots) {
  if (choice.mode === 'bb') {
    await replaceBetweenMarkers(join(root, CONTEXT_PATH), contextBlock(choice), START, END);
    if (choice.parallel) await replaceBetweenMarkers(join(root, PLAN_CONTEXT_PATH), planRuleBlock(), PLAN_START, PLAN_END);
  }
  const researchText = researchBlock(research);
  if (researchText) await replaceBetweenMarkers(join(root, RESEARCH_PATH), researchText, RESEARCH_START, RESEARCH_END);
}

/** Only the text between existing markers changes: a BOM, indentation and everything else of the owner stay byte for byte. */
async function replaceBetweenMarkers(file: string, block: string, start_: string, end_: string) {
  const text = await readText(file);
  const start = text.indexOf(start_);
  const end = text.indexOf(end_, start);
  if (start < 0 || end < 0) return;
  // A file checked out with CRLF (core.autocrlf on Windows) gets the block in CRLF too, so git sees no change.
  const eol = text.slice(start, end).includes('\r\n') ? '\r\n' : '\n';
  const next = `${text.slice(0, start)}${start_}${eol}${block.trim().replace(/\r?\n/g, eol)}${eol}${text.slice(end)}`;
  if (next !== text) await writeAtomic(file, next);
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
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  // A new file gets the umask's mode; an existing one keeps its own (a private 0600 file stays private).
  const mode = await stat(path).then(s => s.mode & 0o777, () => undefined);
  await writeFile(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  if (mode !== undefined) await chmod(tmp, mode); // writeFile's mode is masked by the umask
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
bb thread spawn --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --parent-notifications off <spawn flags> --title 'AIF research · <skill> · <topic>' --prompt-file "<prompt>" --json
\`\`\`

3. Wait for each: \`bb thread wait <id> --status idle --timeout 8m\`, repeating while it still works. The report is \`bb thread output <id>\`.
4. Use the reports exactly as the skill uses its subagent results and continue the skill. Its rules on artifacts, questions and approvals do not change.

If \`bb thread spawn\` fails, say so and do that research yourself; do not repeat the same error. Use no \`node\` commands in this flow. In PowerShell the BB variables are \`$env:BB_PROJECT_ID\`, \`$env:BB_THREAD_ID\` and \`$env:BB_ENVIRONMENT_ID\`, not \`$BB_PROJECT_ID\`.`;
}

function parallelSection(n: number): string {
  return `## Parallel mode (managed by BB AIF Helper)

The owner allowed up to ${n} workers at once. Run independent plan tasks in parallel, each worker in its own git worktree copy of the project:

1. Get the groups: \`bb plugin run aif-chat groups --target "<plan path>" --max ${n} --json\`. It answers \`{ groups, coordinatorOnly }\` — groups of task ids in execution order — or \`{ error }\`. On \`error\`, or for a fix plan, ultra bundle or OpenSpec change, use the one-worker flow above. Tasks in \`coordinatorOnly\` (commit and deploy tasks) you do yourself, as the plan says. A group with one task also uses the one-worker flow.
2. Checkpoint before each group with two or more tasks: \`bb plugin run aif-chat checkpoint --target "<plan path>" --group <N> --json\`. It lists every changed file of this workspace (\`{ files: [{ status, path }], token }\`; the plugin's own \`.ai-factory/skill-context/\` is never listed). If every listed file is your own change from earlier tasks of this plan, run it again with \`--token <token>\`: the plugin commits exactly those files locally (no push) and refuses if anything changed since the list — then list again. If a file is not yours, stop and ask the owner; never commit it. The copies are built from the last commit and would not see uncommitted work.
3. For each task of the group write its brief to a temporary file (as in step 1 of the one-worker flow) and start its worker: \`bb plugin run aif-chat spawn-worker --target "<plan path>" --task <taskId> --brief "<absolute brief path>" --json\`. It answers \`{ id }\`. The plugin starts the worker with the owner's model on a fresh copy of the project made from the checkpoint commit, as a child of this chat; the folder may be a section inside a larger repository (the copy is of the whole repository, the worker starts in the same subfolder). A retry is the same command: every launch gets its own copy.
4. Wait for all workers of the group (step 4 of the one-worker flow for each id).
5. Bring the results back one worker at a time: \`bb plugin run aif-chat bring-back --worker <id> --json\`. It moves everything the worker changed (new, changed, renamed and deleted files; ignored files such as \`node_modules\` stay out) into this workspace and answers \`{ applied: true, files }\`. \`{ applied: false, empty: true }\`: the worker changed nothing — treat the task as not done. \`{ applied: false, error }\`: the changes do not fit and nothing was changed, the results of earlier tasks are intact; apply nothing more for this group, do not run \`git apply\`, \`git checkout\`, \`git reset\` or \`git stash\` yourself — there is nothing to undo. Stop and report the task and the error to the owner. After a successful bring-back, review the diff and run that task's verification as in step 5 of the one-worker flow.
6. Mark each task done only after its changes are brought back and verified. Then archive its worker (\`bb thread archive <id>\`); BB removes its copy five minutes later.
7. Continue with the next group. The final commits stay as the plan describes; the local checkpoint commits are part of them and are never pushed without the owner's approval.

If \`spawn-worker\` fails for a group, archive the workers it already started, report the error and run the rest of the plan with the one-worker flow.`;
}

export function planRuleBlock(): string {
  return `## Task hints for parallel execution (managed by BB AIF Helper)

The project runs independent plan tasks in parallel. In every plan task line write, after the task text:
- \`Files:\` with every file the task creates or changes, each in backticks, concrete paths only (no globs, no "listed above");
- \`Depends on\` with the task numbers it needs (\`Depends on 2, 4\` or \`Depends on 1-3\`), or \`Depends on —\` when it needs none.
Keep tasks that change the same file dependent or merged. Commit and deploy tasks stay last.`;
}

export function contextBlock(c: Extract<DelegationChoice, { mode: 'bb' }>) {
  const flags = spawnFlags(c);
  const base = `## Code delegation (managed by BB AIF Helper)

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
bb thread spawn --project "$BB_PROJECT_ID" --environment "$BB_ENVIRONMENT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --parent-notifications off ${flags} --title 'AIF · <plan> · <taskId>' --prompt-file "<brief>" --json
\`\`\`

4. Wait: \`bb thread wait <id> --status idle --timeout 8m\`, repeating while the thread still works. The report is \`bb thread output <id>\`.
5. Review \`git diff\` and run the task's verification yourself. Fix a small gap yourself, or send \`bb thread tell <id> '<what to fix>'\` and wait again (step 4).
6. Only after that mark the task done in the plan and move to the next task. One worker at a time: workers share this workspace.

If \`bb thread spawn\` returns an error, report it and implement that task yourself; do not repeat the same error. Use no \`node\` commands in this flow. In PowerShell the BB variables are \`$env:BB_PROJECT_ID\`, \`$env:BB_THREAD_ID\` and \`$env:BB_ENVIRONMENT_ID\`, not \`$BB_PROJECT_ID\`.`;
  if (!c.parallel) return base;
  return base.replace('One worker at a time: workers share this workspace.', 'Outside parallel groups (below), run one worker at a time: workers in this workspace share it.') + '\n\n' + parallelSection(c.parallel);
}

export function writeDelegation(root: string, choice: DelegationChoice, role: DelegationRole = 'implement'): Promise<DelegationState> {
  return serialByRoot(root, () => writeDelegationNow(root, choice, role));
}

async function writeDelegationNow(root: string, choice: DelegationChoice, role: DelegationRole): Promise<DelegationState> {
  const config = await readConfig(root);
  if (!config) throw new Error('В проекте нет .ai-factory.json: сначала установите AI Factory.');
  if (role !== 'implement') {
    const file = join(root, RESEARCH_PATH);
    const text = await readText(file);
    const picked = choice.mode === 'bb' ? stripParallel(choice) : choice;
    const next = mergeContextBlock(text, researchBlock({ ...parseResearch(text), [role]: picked }), RESEARCH_START, RESEARCH_END);
    if (next) await writeAtomic(file, next); else await rm(file, { force: true });
    return readDelegationNow(root);
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
  const planFile = join(root, PLAN_CONTEXT_PATH);
  const planText = await readText(planFile);
  const nextPlan = mergeContextBlock(planText, choice.mode === 'bb' && choice.parallel ? planRuleBlock() : null, PLAN_START, PLAN_END);
  if (nextPlan) await writeAtomic(planFile, nextPlan); else await rm(planFile, { force: true });
  let removedLegacy = false;
  try { await rm(join(root, '.ai-factory/bin/bb-aif-run.mjs')); removedLegacy = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await writeAtomic(join(root, '.ai-factory.json'), JSON.stringify(config, null, 2) + '\n');
  const state = await readDelegationNow(root);
  return removedLegacy ? { ...state, removedLegacy } : state;
}
