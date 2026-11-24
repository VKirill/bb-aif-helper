import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';

const ROOT = 'C:\\Users\\Dev User\\репо';
const VALID_DIR = '.ai-factory/scout/mcp-stdio';
const CYRILLIC_SPACE_DIR = '.ai-factory/scout/обзор mcp';

const READY_PLAN = `question: "Как работает stdio в MCP?"
mode: dev
as_of: "2026-11-24"
angles:
  - id: official
    role: discovery
    hypothesis: "Официальная спецификация ограничивает формат сообщений."
    required: true
`;

const READY_CARD = `scout: official
as_of: "2026-11-24"
tools:
  - web_fetch
queries_run: 2
findings:
  - id: F1
    claim: "Сообщения разделяются переводом строки."
    type: fact
    origin: vendor
    evidence:
      - url: https://modelcontextprotocol.io/specification
        capture: full
        source_date: "2026-11-24"
        quote: "Messages are delimited by newlines."
    status: VERIFIED
    confidence: low
    changes_decision: yes
counter_evidence: []
not_found:
  - "Официальных ограничений на размер буфера не найдено."
injection_suspected: []
open_questions: []
`;

const NOT_READY_CARD = `scout: official
as_of: "2026-11-24"
tools:
  - web_fetch
queries_run: 1
findings: []
counter_evidence: []
not_found:
  - "Ничего не найдено."
injection_suspected: []
open_questions: []
`;

type Corpus = { plan: string; cards: { name: string; text: string }[]; report: string | null; opportunities: string | null };

async function setup(handler: (input: { root: string; dir: string }) => Corpus | Promise<Corpus>) {
  const calls: { method: string; input: any; hostId: string }[] = [];  // guardian: allow — loose mock of the BB SDK and host RPC in this test
  const thread = makeThreadResponse({ id: 'thr_test', projectId: 'proj_test', environmentId: 'env_test', status: 'idle', runtime: { displayStatus: 'idle' } });
  const env = { id: 'env_test', projectId: 'proj_test', path: ROOT, hostId: 'host_win', status: 'ready', lifecycle: { phase: 'active' } };
  const h = createFakePluginHost({
    pluginId: 'aif-chat',
    agentSkillIds: ['aif-chat', 'aif-scout'],
    experimental_hostEntry: true,
    sdk: {
      threads: { get: async () => thread, list: async () => [], events: { list: async () => [], wait: async () => null }, queuedMessages: { list: async () => [] } } as any,  // guardian: allow — loose mock of the BB SDK and host RPC in this test
      environments: { get: async () => env } as any,  // guardian: allow — loose mock of the BB SDK and host RPC in this test
    },
    experimental_callHostRpc: async (call) => {
      calls.push({ method: call.method, input: call.input, hostId: call.hostId });
      if (call.method === 'scoutCorpus') return handler(call.input as { root: string; dir: string });
      throw new Error(`unexpected host rpc ${call.method}`);
    },
  });
  await plugin(h.bb);
  return { h, calls };
}

test('scout-check returns exit 0 and JSON READY verdict for a ready corpus', async () => {
  const { h, calls } = await setup(() => ({
    plan: READY_PLAN,
    cards: [{ name: 'official.yaml', text: READY_CARD }],
    report: null,
    opportunities: null,
  }));
  try {
    const result = await h.harness.behavior.runCli(['scout-check', '--thread', 'thr_test', '--dir', VALID_DIR, '--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    const parsed = JSON.parse(result.stdout!);
    assert.equal(parsed.verdict, 'READY');
    assert.equal(parsed.mode, 'dev');
    assert.equal(parsed.counts.findings, 1);
    assert.deepEqual(calls[0], { method: 'scoutCorpus', input: { root: ROOT, dir: VALID_DIR }, hostId: 'host_win' });
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

test('scout-check returns exit 1 and keeps JSON in stdout for NOT_READY corpus', async () => {
  const { h } = await setup(() => ({
    plan: READY_PLAN,
    cards: [{ name: 'official.yaml', text: NOT_READY_CARD }],
    report: null,
    opportunities: null,
  }));
  try {
    const result = await h.harness.behavior.runCli(['scout-check', '--thread', 'thr_test', '--dir', VALID_DIR, '--json']);
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout!);
    assert.equal(parsed.verdict, 'NOT_READY');
    assert.ok(parsed.problems.some((p: { code: string }) => p.code === 'missing_required'));
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

test('scout-check prints human-readable verdict without --json and passes spaces/Cyrillic dir unchanged', async () => {
  const { h, calls } = await setup(() => ({
    plan: READY_PLAN,
    cards: [{ name: 'official.yaml', text: READY_CARD }],
    report: null,
    opportunities: null,
  }));
  try {
    const result = await h.harness.behavior.runCli(['scout-check', '--thread', 'thr_test', '--dir', CYRILLIC_SPACE_DIR]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout ?? '', /READY/);
    assert.deepEqual(calls[0].input, { root: ROOT, dir: CYRILLIC_SPACE_DIR });
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

test('scout-check returns exit 1 with host error text in stderr', async () => {
  const { h } = await setup(() => {
    throw new Error('Папка разведки должна быть .ai-factory/scout/<slug>.');
  });
  try {
    const result = await h.harness.behavior.runCli(['scout-check', '--thread', 'thr_test', '--dir', 'outside/dir', '--json']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? '', /Папка разведки должна быть/);
  } finally {
    await h.harness.lifecycle.dispose();
  }
});

test('scout-check rejects missing --dir and unknown flags before calling host', async () => {
  const { h, calls } = await setup(() => ({
    plan: READY_PLAN,
    cards: [{ name: 'official.yaml', text: READY_CARD }],
    report: null,
    opportunities: null,
  }));
  try {
    const missingDir = await h.harness.behavior.runCli(['scout-check', '--thread', 'thr_test', '--json']);
    assert.equal(missingDir.exitCode, 1);
    assert.match(missingDir.stderr ?? '', /--dir/);

    const unknownFlag = await h.harness.behavior.runCli(['scout-check', '--thread', 'thr_test', '--dir', VALID_DIR, '--bogus', '1']);
    assert.equal(unknownFlag.exitCode, 1);
    assert.match(unknownFlag.stderr ?? '', /Неизвестный аргумент/);

    assert.equal(calls.length, 0);
  } finally {
    await h.harness.lifecycle.dispose();
  }
});
