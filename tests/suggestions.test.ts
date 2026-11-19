import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAifCommands, extractAifInvocations, analyzeReply, chipDraft, isCommandDraft, nextStepItems } from '../suggestions.ts';

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
test('isCommandDraft detects leading / and $ commands and ignores the pill', () => {
  const pill = { from: 0, to: 11, kind: 'plugin', provider: 'aif-mode', id: 'aif-mode' };
  assert.equal(isCommandDraft({ text: '/aif-plan fix', mentions: [] }), true);
  assert.equal(isCommandDraft({ text: '  $aif-verify', mentions: [] }), true);
  assert.equal(isCommandDraft({ text: 'fix /aif-plan', mentions: [] }), false);
  assert.equal(isCommandDraft({ text: '@AI Factory /aif-plan', mentions: [pill] }), true);
  assert.equal(isCommandDraft({ text: '@AI Factory', mentions: [pill] }), false);
  assert.equal(isCommandDraft({ text: '', mentions: [] }), false);
});
test('chipDraft drops the AI Factory pill: a draft holding only it counts as empty', () => {
  const pill = { from: 0, to: 10, kind: 'plugin', provider: 'aif-mode', id: 'aif-mode' };
  const result = chipDraft({ text: 'AI Factory', mentions: [pill] }, '/aif-plan', 'aif-plan');
  assert.equal(result.submit, false);
  assert.equal(result.text, '/aif-plan ');
  assert.deepEqual(result.mentions, []);
});
test('chipDraft removes the pill from a command draft and shifts other mentions', () => {
  const pill = { from: 0, to: 11, kind: 'plugin', provider: 'aif-mode', id: 'aif-mode' };
  const mention = { from: 26, to: 28, label: '@x', kind: 'path', path: 'x', source: 'workspace', entryKind: 'file' };
  const result = chipDraft({ text: '@AI Factory /aif-plan fix @x', mentions: [pill, mention] }, '/aif-fix', 'aif-fix');
  assert.equal(result.submit, true);
  assert.equal(result.text, ' /aif-fix fix @x');
  assert.deepEqual(result.mentions, [{ ...mention, from: 14, to: 16 }]);
});
test('chipDraft drops the pill when prepending a command to plain text', () => {
  const pill = { from: 4, to: 15, kind: 'plugin', provider: 'aif-mode', id: 'aif-mode' };
  const result = chipDraft({ text: 'fix @AI Factory now', mentions: [pill] }, '/aif-verify', 'aif-verify');
  assert.equal(result.submit, true);
  assert.equal(result.text, '/aif-verify fix  now');
  assert.deepEqual(result.mentions, []);
});

test('next-step chips: available next actions of installed skills, one per skill, at most three, runtime prefix', () => {
  const a = (id: string, command: string, group: 'next' | 'check' = 'next', available = true) => ({ id, label: id, command, group, reason: '', available });
  const actions = [a('commit', '/aif-commit'), a('verify', '/aif-verify', 'check'), a('plan', '/aif-plan', 'next', false),
    a('impl', '/aif-implement @.ai-factory/plans/x.md'), a('impl2', '/aif-implement'), a('gone', '/aif-gone'), a('qa', '/aif-qa'), a('fix', '/aif-fix')];
  const skills = ['aif-commit', 'aif-verify', 'aif-plan', 'aif-implement', 'aif-qa', 'aif-fix'];
  assert.deepEqual(nextStepItems(actions as any, { skills, invalid: false, prefix: '$', hidden: ['aif-qa'] }).map(i => i.command),
    ['$aif-commit', '$aif-implement @.ai-factory/plans/x.md', '$aif-fix']);
  assert.deepEqual(nextStepItems(actions as any, { skills, invalid: true, prefix: '/', hidden: [] }), []);
});

test('inline code spans keep the full one-line command with its arguments', () => {
  const reply = 'Next: `/aif-fix refresh src/rooms/sma-map/provenance.json via npx tsx scripts/sma-provenance.ts so npm run sma:facts:check passes on HEAD` or `/aif-commit`.';
  const command = 'aif-fix refresh src/rooms/sma-map/provenance.json via npx tsx scripts/sma-provenance.ts so npm run sma:facts:check passes on HEAD';
  assert.deepEqual(extractAifInvocations(reply), [
    { id: 'aif-fix', command }, { id: 'aif-commit', command: 'aif-commit' },
  ]);
  assert.equal(analyzeReply(reply).commands.get('aif-fix'), command);
});
test('a span variant with arguments replaces the bare command; the first one wins', () => {
  assert.deepEqual(extractAifInvocations('/aif-plan then `/aif-plan full #1` then `/aif-plan other`'),
    [{ id: 'aif-plan', command: 'aif-plan full #1' }]);
  assert.deepEqual(extractAifInvocations('`/aif-plan full #1` and /aif-plan'),
    [{ id: 'aif-plan', command: 'aif-plan full #1' }]);
  assert.deepEqual(extractAifInvocations('/aif-zeta `/aif-alpha x` /aif-commit `/aif-commit --amend`'),
    [{ id: 'aif-zeta', command: 'aif-zeta' }, { id: 'aif-alpha', command: 'aif-alpha x' }, { id: 'aif-commit', command: 'aif-commit --amend' }]);
});
test('overlong, multiline, fenced or control-character spans keep only the bare command', () => {
  assert.deepEqual(extractAifInvocations('`/aif-fix ' + 'x'.repeat(300) + '`'), [{ id: 'aif-fix', command: 'aif-fix' }]);
  assert.deepEqual(extractAifInvocations('`/aif-fix x\ny`'), [{ id: 'aif-fix', command: 'aif-fix' }]);
  assert.deepEqual(extractAifInvocations('```\n/aif-fix x\n```'), [{ id: 'aif-fix', command: 'aif-fix' }]);
  assert.deepEqual(extractAifInvocations('`/aif-fix\tx`'), [{ id: 'aif-fix', command: 'aif-fix' }]);
});
test('span commands are trimmed and inner whitespace collapses to single spaces', () => {
  assert.deepEqual(extractAifInvocations('`  /aif-fix   refresh   x  `'), [{ id: 'aif-fix', command: 'aif-fix refresh x' }]);
  assert.deepEqual(extractAifInvocations('`$aif-verify @plan.md`'), [{ id: 'aif-verify', command: 'aif-verify @plan.md' }]);
});
test('chipDraft submits a command with arguments from an empty draft', () => {
  assert.deepEqual(chipDraft({ text: '', mentions: [] }, '/aif-fix refresh x so y', 'aif-fix'),
    { text: '/aif-fix refresh x so y', mentions: [], submit: true });
  assert.deepEqual(chipDraft({ text: '  \n ', mentions: [] }, '/aif-verify @plan.md', 'aif-verify'),
    { text: '/aif-verify @plan.md', mentions: [], submit: true });
});
test('chipDraft puts an argument command on the first line of a plain draft without submitting', () => {
  const mention = { from: 6, to: 8, label: '@a', kind: 'path', path: 'a', source: 'workspace', entryKind: 'file' };
  const result = chipDraft({ text: 'check @a now', mentions: [mention] }, '/aif-verify @plan.md', 'aif-verify');
  assert.equal(result.submit, false);
  assert.equal(result.text, '/aif-verify @plan.md\ncheck @a now');
  assert.deepEqual(result.mentions, [{ ...mention, from: 27, to: 29 }]);
});
test('chipDraft replaces the whole first line of a command draft with an argument command', () => {
  assert.deepEqual(chipDraft({ text: '/aif-fix B old args', mentions: [] }, '/aif-fix A', 'aif-fix'),
    { text: '/aif-fix A', mentions: [], submit: false });
  assert.deepEqual(chipDraft({ text: '/aif-fix B\nkeep this line', mentions: [] }, '/aif-fix A', 'aif-fix'),
    { text: '/aif-fix A\nkeep this line', mentions: [], submit: false });
  assert.deepEqual(chipDraft({ text: '/aif-plan ', mentions: [] }, '/aif-fix A', 'aif-fix'),
    { text: '/aif-fix A', mentions: [], submit: false });
});
test('chipDraft drops mentions inside the replaced first line and shifts later ones', () => {
  const inside = { from: 9, to: 11, label: '@x', kind: 'path', path: 'x', source: 'workspace', entryKind: 'file' };
  const after = { from: 17, to: 19, label: '@y', kind: 'path', path: 'y', source: 'workspace', entryKind: 'file' };
  const result = chipDraft({ text: '/aif-fix @x\nkeep @y', mentions: [inside, after] }, '/aif-verify @plan.md', 'aif-verify');
  assert.equal(result.submit, false);
  assert.equal(result.text, '/aif-verify @plan.md\nkeep @y');
  assert.deepEqual(result.mentions, [{ ...after, from: 26, to: 28 }]);
});
