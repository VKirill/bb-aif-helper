import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// Code delegation: /aif-implement hands each plan task to a BB thread on the
// model the owner picked in the panel. `.ai-factory.json` → phases.implement is
// the single source of truth (AI Factory's own dispatch config); the runner and
// the skill-context block are managed copies derived from it.

export const RUNNER_PATH = '.ai-factory/bin/bb-aif-run.mjs';
export const CONTEXT_PATH = '.ai-factory/skill-context/aif-implement/SKILL.md';
const START = '<!-- bb-aif-helper:delegation:start -->';
const END = '<!-- bb-aif-helper:delegation:end -->';
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
  configured: z.boolean(),
  // phases.implement points at an agent this plugin does not manage.
  foreign: z.string().nullable(),
  error: z.string().nullable(),
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

export async function readDelegation(root: string): Promise<DelegationState> {
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
export function mergeContextBlock(existing: string, block: string | null): string {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  const outside = start >= 0 && end > start ? existing.slice(0, start) + existing.slice(end + END.length) : existing;
  const rest = outside.replace(/\n{3,}/g, '\n\n').trim();
  if (!block) return rest ? rest + '\n' : '';
  return `${rest ? rest + '\n\n' : ''}${START}\n${block.trim()}\n${END}\n`;
}

export function contextBlock(c: Extract<DelegationChoice, { mode: 'bb' }>) {
  return `## Code delegation (managed by BB AIF Helper)

The project owner chose \`${modelSpec(c)}\` (BB provider/model?reasoning&tier) to write the code of plan tasks. The source of truth is \`.ai-factory.json\` → \`phases.implement\`; re-read it before each task. If it no longer has \`"agent": "bb"\`, implement tasks yourself as usual.

You stay the coordinator: you own the plan, its checkboxes, verification and commits. For each plan task, instead of editing the code yourself:

1. Write the task brief to a temporary file: the plan path, the task id and its full text, the relevant files and project rules, the verification commands, and what done means for this task.
2. Start the worker: \`node ${RUNNER_PATH} start --prompt-file <brief>\`. It prints \`{"threadId": "..."}\` and the worker appears as a child thread in BB.
3. Wait: \`node ${RUNNER_PATH} wait <threadId>\`. It returns within 8 minutes; repeat while \`status\` is \`running\`.
4. Review the worker report and \`git diff\`, then run the task's verification yourself. Fix a small gap yourself, or send a follow-up with \`bb thread tell <threadId> '<what to fix>'\` and wait again.
5. Only after that mark the task done in the plan and move to the next task. One worker at a time: workers share this workspace.

If \`start\` fails (no BB thread environment, provider unavailable), report the error and implement that task yourself. Do not retry the same failure more than once.`;
}

export async function writeDelegation(root: string, choice: DelegationChoice): Promise<DelegationState> {
  const config = await readConfig(root);
  if (!config) throw new Error('В проекте нет .ai-factory.json: сначала установите AI Factory.');
  const phases: Json = isObject(config.phases) ? { ...config.phases } : {};
  const agents: Json = isObject(config.dispatchAgents) ? { ...config.dispatchAgents } : {};
  const current = isObject(phases.implement) ? phases.implement : null;
  if (current && current.agent !== AGENT) throw new Error(`phases.implement уже настроен на агента «${String(current.agent)}». Измените его вручную в .ai-factory.json.`);
  if (choice.mode === 'bb') {
    phases.implement = { agent: AGENT, model: modelSpec(choice), timeoutMs: TIMEOUT_MS };
    agents[AGENT] = { command: `node ${RUNNER_PATH} run {model} {prompt}` };
    config.phases = phases; config.dispatchAgents = agents;
    // Phases without dispatch fall back to "manual" (printed instructions) in AI Factory.
    config.dispatch = 'auto';
  } else {
    delete phases.implement; delete agents[AGENT];
    if (Object.keys(phases).length) config.phases = phases; else { delete config.phases; delete config.dispatch; }
    if (Object.keys(agents).length) config.dispatchAgents = agents; else delete config.dispatchAgents;
  }
  const contextFile = join(root, CONTEXT_PATH);
  let context = '';
  try { context = await readFile(contextFile, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const nextContext = mergeContextBlock(context, choice.mode === 'bb' ? contextBlock(choice) : null);
  if (choice.mode === 'bb') await writeAtomic(join(root, RUNNER_PATH), RUNNER_SOURCE);
  else await rm(join(root, RUNNER_PATH), { force: true });
  if (nextContext) await writeAtomic(contextFile, nextContext); else await rm(contextFile, { force: true });
  await writeAtomic(join(root, '.ai-factory.json'), JSON.stringify(config, null, 2) + '\n');
  return readDelegation(root);
}

/** Node runner written into the project; no dependencies, works on macOS, Linux and Windows. */
export const RUNNER_SOURCE = String.raw`#!/usr/bin/env node
// Managed by BB AIF Helper: rewritten when the code model changes in the AI Factory panel.
// start --prompt-file <path>   spawn a BB child thread on phases.implement.model, print {"threadId"}
// wait <threadId> [--timeout 8m]  print {"status":"running"} or the finished worker report
// run <provider/model?reasoning=…&tier=…> <prompt>  blocking start+wait, used by "ai-factory dispatch implement"
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const bb = process.env.BB_CLI || 'bb';
const DONE = new Set(['idle', 'error']);
const HEADER = 'You are an implementation worker delegated by an AI Factory /aif-implement coordinator (BB thread ' + process.env.BB_THREAD_ID + ').\n'
  + 'Do exactly the one task below in the current workspace. Do not edit the plan file or its checkboxes, do not commit, push or switch branches, and do not start AI Factory skills.\n'
  + 'Run the verification commands the task names. Finish with a short report: what changed, the files you touched, the checks you ran with their results, and anything left open.\n\n';

function bbJson(args, input) {
  const out = execFileSync(bb, [...args, '--json'], { encoding: 'utf8', input, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 32 << 20, shell: process.platform === 'win32' });
  const value = JSON.parse(out);
  if (value && value.ok === false) throw new Error(value.error && value.error.message || 'bb command failed');
  return value;
}
function spec(value) {
  const m = /^([\w.-]+)\/([^\s?&#]+)(?:\?([\w.=&-]+))?$/.exec(value || '');
  if (!m) throw new Error('model must be provider/model?reasoning=…&tier=…, got: ' + value);
  const q = new URLSearchParams(m[3] || '');
  return { provider: m[1], model: m[2], reasoning: q.get('reasoning'), tier: q.get('tier') };
}
function configured() {
  const phase = (JSON.parse(readFileSync('.ai-factory.json', 'utf8')).phases || {}).implement;
  if (!phase || phase.agent !== 'bb' || !phase.model) throw new Error('.ai-factory.json phases.implement is not set to a BB model');
  return phase.model;
}
function start(prompt, model) {
  const { BB_THREAD_ID, BB_ENVIRONMENT_ID, BB_PROJECT_ID } = process.env;
  if (!BB_THREAD_ID || !BB_ENVIRONMENT_ID || !BB_PROJECT_ID) throw new Error('run inside a BB thread: BB_THREAD_ID, BB_ENVIRONMENT_ID or BB_PROJECT_ID is missing');
  const s = spec(model);
  const args = ['thread', 'spawn', '--project', BB_PROJECT_ID, '--environment', BB_ENVIRONMENT_ID, '--parent-self',
    '--provider', s.provider, '--model', s.model, '--prompt-file', '-'];
  if (s.reasoning) args.push('--reasoning-level', s.reasoning);
  if (s.tier && s.tier !== 'default') args.push('--service-tier', s.tier);
  const thread = bbJson(args, HEADER + prompt);
  return thread.id || thread.thread && thread.thread.id;
}
function status(threadId) { return bbJson(['thread', 'show', threadId]).thread.status; }
function wait(threadId, ms) {
  const deadline = Date.now() + ms;
  let state = status(threadId);
  while (!DONE.has(state) && Date.now() < deadline) {
    try { bbJson(['thread', 'wait', threadId, '--status', 'idle', '--timeout', Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000))) + 's']); } catch {}
    state = status(threadId);
  }
  if (!DONE.has(state)) return { threadId, status: 'running' };
  return { threadId, status: state, output: bbJson(['thread', 'output', threadId]).output };
}
function duration(value) {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(value || '8m');
  if (!m) throw new Error('bad --timeout: ' + value);
  return Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5 }[m[2] || 's'];
}
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'start') {
    const file = flag(args, '--prompt-file');
    if (!file) throw new Error('start needs --prompt-file <path>');
    out({ threadId: start(readFileSync(file, 'utf8'), configured()) });
  } else if (command === 'wait' && args[0]) {
    out(wait(args[0], duration(flag(args, '--timeout'))));
  } else if (command === 'run' && args[0] && args[1]) {
    const result = wait(start(args.slice(1).join(' '), args[0]), Infinity);
    process.stdout.write((result.output || '') + '\n');
    process.exitCode = result.status === 'idle' ? 0 : 1;
  } else {
    throw new Error('usage: bb-aif-run start --prompt-file <path> | wait <threadId> [--timeout 8m] | run <provider/model?reasoning=…&tier=…> <prompt>');
  }
} catch (error) {
  process.stderr.write('bb-aif-run: ' + (error && error.message || error) + '\n');
  process.exitCode = 2;
}
`;
