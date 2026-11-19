import test from 'node:test';
import assert from 'node:assert/strict';
import { readSessionBrief, briefCommands, sessionBriefBlocked } from '../session-brief.ts';
import { workflowActions } from '../workflow.ts';
import { snapshot, fixture } from './fixtures.ts';
import { collectSnapshot } from '../reader.ts';
import type { HistoryRow } from '../check-history.ts';

const s = snapshot({ profile: 'aifhub-openspec' }); s.target!.kind = 'openspec';
const request = (seq: number, text: string) => ({ seq, type: 'client/turn/requested', data: { input: [{ type: 'text', text }] } }) as HistoryRow;
const reply = (seq: number, text: string, nested = false) => ({ seq, type: 'item/completed', data: { item: { type: 'agentMessage', text, ...(nested ? { parentToolCallId: 'child' } : {}) } } }) as HistoryRow;

test('SessionBrief stale from the screenshot is scoped and only an explicit fresh report clears it', () => {
  const text = 'Задача заблокирована: **SessionBrief: stale** — ревизия источников и контекст расходятся.\n1. `/aif-mode sync --change demo`\n2. `ai-factory aifhub-session-brief compile --change demo --json`';
  const stale = readSessionBrief([reply(2, text)], s.target)!;
  assert.equal(stale.status, 'stale');
  assert.equal(readSessionBrief([reply(3, 'Команда завершена, exit 0.')], s.target, stale)?.status, 'stale');
  assert.equal(readSessionBrief([reply(4, 'SessionBrief: fresh.\n--change other')], s.target, stale)?.status, 'stale');
  assert.equal(readSessionBrief([reply(5, '> SessionBrief: fresh\n--change demo')], s.target, stale)?.status, 'stale');
  const fresh = readSessionBrief([request(6, 'ai-factory aifhub-session-brief status --change demo --json'), reply(7, 'SessionBrief: fresh')], s.target, stale)!;
  assert.equal(fresh.status, 'fresh'); assert(!sessionBriefBlocked({ ...s, sessionBrief: fresh }));
  assert.equal(readSessionBrief([reply(2, text)], s.target, fresh)?.status, 'fresh');
});

test('unbound, quoted and nested context claims do not block another plan', () => {
  assert.equal(readSessionBrief([reply(2, 'SessionBrief: stale')], s.target), undefined);
  assert.equal(readSessionBrief([request(1, '$aif-implement demo'), reply(2, 'SessionBrief: stale', true)], s.target), undefined);
  assert.equal(readSessionBrief([request(1, '$aif-implement demo'), reply(2, 'SessionBrief: stale\n--change other')], s.target), undefined);
  assert.equal(readSessionBrief([request(1, '$aif-implement demo'), reply(2, '```text\nSessionBrief: stale\n```')], s.target), undefined);
  assert.equal(readSessionBrief([request(1, '$aif-implement demo'), reply(2, 'SessionBrief: missing')], s.target)?.status, 'missing');
});

test('native valid JSON clears only the matching CLI context report and a bare exit code never clears it', () => {
  const stale = { target: s.target!.path, seq: 1, status: 'stale' as const };
  const json = { ok: true, status: 'valid', change_id: 'demo', digest: 'a'.repeat(64), stale_reasons: [], paths: { json: '.ai-factory/state/demo/context/session-brief.json' } };
  const output = '```json\n' + JSON.stringify(json) + '\n```';
  const launch = request(2, 'ai-factory aifhub-session-brief status --change demo --json');
  assert.equal(readSessionBrief([launch, reply(3, output)], s.target, stale)?.status, 'valid');
  assert.equal(readSessionBrief([request(2, '$aif-implement demo'), reply(3, output)], s.target, stale)?.status, 'stale');
  assert.equal(readSessionBrief([launch, reply(3, output.replace('"ok":true', '"ok":false'))], s.target, stale)?.status, 'stale');
});

test('only the bounded SessionBrief compile CLI is offered with its explicit change and no shell tail', () => {
  const command = 'ai-factory aifhub-session-brief compile --change demo --json';
  assert.equal(briefCommands('`' + command + '`')[0].command, command);
  assert.equal(briefCommands(command + ' && run-other')[0].command, command);
  for (const text of ['ai-factory update --force', 'ai-factory aifhub-session-brief compile --json',
    'https://example.org/' + command, command.replace('demo', '../other')]) assert.deepEqual(briefCommands(text), []);
});

test('the screenshot natural recheck clears stale for its scoped compile, including the issue number', () => {
  const target = { ...s.target!, id: '213-future-work-log-dates', path: 'openspec/changes/213-future-work-log-dates/tasks.md' };
  const stale = { target: target.path, status: 'stale' as const, seq: 1 };
  const launch = request(2, 'ai-factory aifhub-session-brief compile --change 213-future-work-log-dates --json');
  const text = 'SessionBrief #213 пересобран; повторная проверка подтвердила **valid**, без stale/blocker причин.\n\nСледующий шаг: `$aif-implement 213-future-work-log-dates` — задача 2.1. Прогресс **3/9**, реализация этим запуском не выполнялась.';
  const result = readSessionBrief([launch, reply(3, text)], target, stale)!;
  assert.equal(result.status, 'valid'); assert.equal(result.seq, 3);
  const current = { ...s, target, sessionBrief: result };
  assert(!sessionBriefBlocked(current));
  assert.equal(workflowActions(current).find(a => a.id === 'implement')?.available, true);
  assert(!workflowActions(current).some(a => a.id === 'context-compile'));
  assert.equal(readSessionBrief([launch, reply(3, text.replace('**valid**', '`valid`'))], target, stale)?.status, 'valid');
  assert.equal(readSessionBrief([launch, reply(3, text.replace('#213', '#69'))], target, stale)?.status, 'stale');
});

test('natural valid recovery is not inferred from expectations, negation, examples or a different CLI scope', () => {
  const stale = { target: s.target!.path, status: 'stale' as const, seq: 1 };
  const launch = request(2, 'ai-factory aifhub-session-brief status --change demo --json');
  for (const text of ['SessionBrief пересобран; ожидается valid.',
    'SessionBrief пересобран; повторная проверка не подтвердила valid.',
    'SessionBrief пересобран; повторная проверка подтвердила valid. Но valid не подтверждён для текущих файлов.',
    'Пример: SessionBrief пересобран; повторная проверка подтвердила valid.',
    '> SessionBrief пересобран; повторная проверка подтвердила valid.',
    'SessionBrief пересобран; повторная проверка подтвердила valid.\nSessionBrief: stale']) {
    assert.equal(readSessionBrief([launch, reply(3, text)], s.target, stale)?.status, 'stale', text);
  }
  const text = 'SessionBrief пересобран; повторная проверка подтвердила valid.';
  assert.equal(readSessionBrief([request(2, 'ai-factory aifhub-session-brief compile --change other --json'), reply(3, text)], s.target, stale)?.status, 'stale');
  assert.equal(readSessionBrief([request(2, '$aif-implement demo'), reply(3, text)], s.target, stale)?.status, 'stale');
});

test('context repair actions stay scoped while implementation is disabled, without replacing improve or gates', () => {
  const current = structuredClone(s);
  current.versions.globalCli = '2.21.0';
  current.extensions = [{ name: 'aifhub-extension', installedVersion: '1.8.1', recordedVersion: '1.8.1', source: 'local', state: 'present', contributions: [], commands: ['aifhub-session-brief'] }];
  current.sessionBrief = { status: 'stale', seq: 1, target: current.target!.path };
  const actions = workflowActions(current);
  assert.equal(actions[0].id, 'context-sync');
  assert.equal(actions[0].command, '$aif-mode sync --change "demo"');
  assert.equal(actions[1].command, 'ai-factory aifhub-session-brief compile --change "demo" --json');
  assert.equal(actions[1].available, true);
  assert.equal(actions.find(a => a.id === 'implement')?.disabledReason, 'context-blocked');
  assert.equal(actions.find(a => a.id === 'improve')?.available, true);
  current.extensions[0].commands = [];
  assert.equal(workflowActions(current).find(a => a.id === 'context-compile')?.available, false);
});

test('extension CLI discovery uses only command names and never imports its modules', async () => {
  const f = await fixture(true, true); try {
    await f.write('.ai-factory/extensions/aifhub-extension/extension.json', { name: 'aifhub-extension', version: '1.8.1',
      commands: [{ name: 'aifhub-session-brief', module: './commands/never-imported.mjs' }, { name: 'missing', module: './missing.mjs' }, null, { name: '../bad' }] });
    await f.write('.ai-factory/extensions/aifhub-extension/commands/never-imported.mjs', 'throw new Error("Must never execute");');
    const result = await collectSnapshot({ root: f.root, runtime: 'codex-app', target: '', phase: 'unknown', sourceRepo: '', checkUpdates: false, upstreamRepo: 'lee-to/ai-factory', upstreamRef: '' });
    assert.deepEqual(result.extensions[0].commands, ['aifhub-session-brief']);
  } finally { await f.cleanup(); }
});
