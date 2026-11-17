import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAifCommands, extractAifInvocations, analyzeReply, chipDraft } from '../suggestions.ts';

test('last-answer command names are extracted in order, without arguments or duplicates', () => {
  assert.deepEqual(extractAifCommands('Далее `$aif-architecture`, затем `$aif-roadmap`. Повтор: $aif-architecture; $aif-plan full #177; $aif.'), ['aif-architecture', 'aif-roadmap', 'aif-plan', 'aif']);
});
test('commands inside code blocks work; other variables and embedded names do not match', () => {
  assert.deepEqual(extractAifCommands('```text\n$aif-plan\n```\n$aifhub $aif_analyze $$aif-plan foo$aif-plan /$aif-plan $HOME'), ['aif-plan']);
});
test('suggestions are bounded and do not turn following shell syntax into a command', () => {
  const commands = Array.from({ length: 20 }, (_, i) => `$aif-${i}`).join(' ');
  assert.equal(extractAifCommands(commands).length, 12);
  assert.deepEqual(extractAifCommands('$aif-review; rm -rf x && $aif-plan'), ['aif-review', 'aif-plan']);
  assert.deepEqual(extractAifCommands('x'.repeat(1024 * 1024) + ' $aif-plan'), []);
});

test('slash recommendations from the finalization reply preserve only the fixed sync subcommand', () => {
  const reply = 'Следующие отдельные шаги: `/aif-mode sync`, затем `/aif-commit`. Commit, push и deploy не выполнялись.';
  assert.deepEqual(extractAifCommands(reply), ['aif-mode', 'aif-commit']);
  assert.deepEqual(extractAifInvocations(reply), [
    { id: 'aif-mode', command: 'aif-mode sync' }, { id: 'aif-commit', command: 'aif-commit' },
  ]);
  assert.deepEqual(extractAifInvocations('$aif-mode /aif-mode sync /aif-commit $aif-commit'), [
    { id: 'aif-mode', command: 'aif-mode sync' }, { id: 'aif-commit', command: 'aif-commit' },
  ]);
});

test('slash commands exclude paths, URLs and malformed prefixes and never copy arbitrary arguments', () => {
  assert.deepEqual(extractAifCommands('https://example.org/aif-review /tmp/aif-plan ./aif-fix //aif-commit $/aif-mode /$aif-plan /aifhub /aif_bad'), []);
  for (const text of ['/aif-mode sync --force && shell', '$aif-mode sync; shell', '/aif-mode sync, затем']) {
    assert.deepEqual(extractAifInvocations(text), [{ id: 'aif-mode', command: 'aif-mode sync' }]);
  }
  for (const text of ['/aif-mode sync-other', '/aif-mode sync/path', '/aif-mode\nsync', '/aif-mode openspec', '/aif-mode sync$(shell)']) {
    assert.deepEqual(extractAifInvocations(text), [{ id: 'aif-mode', command: 'aif-mode' }]);
  }
  assert.deepEqual(extractAifInvocations('/aif-plan full @secret #196'), [{ id: 'aif-plan', command: 'aif-plan' }]);
});

test('gate JSON cannot supply prose arguments and an exact gate recommendation retains precedence', () => {
  const gate = { schema_version: 1, gate: 'rules', status: 'warn', blocking: false, blockers: [], affected_files: ['/aif-archive'],
    suggested_next: { command: '/aif-mode', reason: 'Example /aif-mode sync is data.' } };
  const reply = analyzeReply('/aif-mode sync\n```aif-gate-result\n' + JSON.stringify(gate) + '\n```');
  assert.equal(reply.error, null); assert.deepEqual(reply.ids, ['aif-mode']);
  assert.equal(reply.commands.get('aif-mode'), 'aif-mode');
});

test('chipDraft keeps a topic command in an empty draft without submitting', () => {
  for (const id of ['aif-explore', 'aif-plan', 'aif-fix']) {
    assert.deepEqual(chipDraft({ text: '', mentions: [] }, `/${id}`, id), { text: `/${id} `, mentions: [], submit: false });
  }
});
test('chipDraft submits commands that need no topic text from an empty draft', () => {
  for (const id of ['aif-verify', 'aif-commit', 'aif-improve']) {
    assert.deepEqual(chipDraft({ text: '', mentions: [] }, `/${id}`, id), { text: `/${id}`, mentions: [], submit: true });
  }
});
test('chipDraft prepends to a non-empty draft and shifts mentions past the inserted command', () => {
  const mention = { from: 6, to: 8, label: '@a', kind: 'path', path: 'a', source: 'workspace', entryKind: 'file' };
  const result = chipDraft({ text: 'check @a now', mentions: [mention] }, '/aif-verify', 'aif-verify');
  assert.equal(result.submit, true);
  assert.equal(result.text, '/aif-verify check @a now');
  assert.deepEqual(result.mentions, [{ ...mention, from: 18, to: 20 }]);
});
test('chipDraft replaces a leading command, keeps the tail and shifts later mentions by the delta', () => {
  const mention = { from: 14, to: 16, label: '@x', kind: 'path', path: 'x', source: 'workspace', entryKind: 'file' };
  assert.deepEqual(chipDraft({ text: '/aif-plan fix @x', mentions: [mention] }, '/aif-fix', 'aif-fix'),
    { text: '/aif-fix fix @x', mentions: [{ ...mention, from: 13, to: 15 }], submit: true });
  assert.deepEqual(chipDraft({ text: '  /aif-plan fix', mentions: [] }, '/aif-fix', 'aif-fix'), { text: '  /aif-fix fix', mentions: [], submit: true });
  assert.deepEqual(chipDraft({ text: '/aif-plan ', mentions: [] }, '/aif-fix', 'aif-fix'), { text: '/aif-fix ', mentions: [], submit: false });
  assert.deepEqual(chipDraft({ text: '/aif-verify', mentions: [] }, '/aif-commit', 'aif-commit'), { text: '/aif-commit', mentions: [], submit: true });
});
test('chipDraft shifts two mentions and preserves their extra fields', () => {
  const mentions = [
    { from: 6, to: 8, label: '@a', kind: 'path', path: 'a', source: 'workspace', entryKind: 'file' },
    { from: 13, to: 15, label: '@b', kind: 'thread', threadId: 'thr_1', projectId: 'proj_1' },
  ];
  const result = chipDraft({ text: 'check @a then @b', mentions }, '$aif-fix', 'aif-fix');
  assert.equal(result.submit, true);
  assert.deepEqual(result.mentions, [{ ...mentions[0], from: 15, to: 17 }, { ...mentions[1], from: 22, to: 24 }]);
});
test('chipDraft handles the dollar prefix used by codex runtimes', () => {
  assert.deepEqual(chipDraft({ text: '', mentions: [] }, '$aif-verify', 'aif-verify'), { text: '$aif-verify', mentions: [], submit: true });
  assert.deepEqual(chipDraft({ text: '$aif-plan old task', mentions: [] }, '$aif-fix', 'aif-fix'), { text: '$aif-fix old task', mentions: [], submit: true });
});
test('chipDraft treats a whitespace-only draft as empty', () => {
  assert.deepEqual(chipDraft({ text: '  \n\t ', mentions: [] }, '/aif-plan', 'aif-plan'), { text: '/aif-plan ', mentions: [], submit: false });
  assert.deepEqual(chipDraft({ text: '   ', mentions: [] }, '/aif-commit', 'aif-commit'), { text: '/aif-commit', mentions: [], submit: true });
});
test('chipDraft prepends when a mention overlaps the leading command instead of replacing it', () => {
  const mention = { from: 1, to: 4, label: 'aif', kind: 'command', trigger: '/', name: 'aif-plan', source: 'skill', origin: 'builtin', argumentHint: null };
  const result = chipDraft({ text: '/aif-plan fix this', mentions: [mention] }, '/aif-verify', 'aif-verify');
  assert.equal(result.submit, true);
  assert.equal(result.text, '/aif-verify /aif-plan fix this');
  assert.deepEqual(result.mentions, [{ ...mention, from: 13, to: 16 }]);
});
