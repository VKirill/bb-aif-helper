import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAifCommands, extractAifInvocations, analyzeReply, rulesSyncCommand } from '../suggestions.ts';

test('stale generated rules use only an exact, scoped sync invocation in completed code', () => {
  const command = 'ai-factory aifhub-mode sync --change "268-demo" --json';
  const report = 'SessionBrief актуален (`valid`), но проверка отметила правила как `stale-generated-rules`.\n';
  assert.equal(rulesSyncCommand(report + '```powershell\r\n' + command + '\r\n```', '268-demo'), command);
  assert.equal(rulesSyncCommand(report + '`' + command + '`', '268-demo'), command);
  for (const text of [report + '```powershell\n' + command, report + '```powershell\n' + command + ' --all\n```',
    report + '`' + command + '; next-command`', '```text\nstale-generated-rules\n' + command + '\n```',
    report + '`' + command + '` и `ai-factory aifhub-mode sync --change other --json`']) {
    assert.equal(rulesSyncCommand(text, '268-demo'), undefined);
  }
  assert.equal(rulesSyncCommand(report + '`' + command + '`', 'other'), undefined);
});

test('last-answer command names are extracted in order, without arguments or duplicates', () => {
  assert.deepEqual(extractAifCommands('Далее `$aif-architecture`, затем `$aif-roadmap`. Повтор: $aif-architecture; $aif-plan full #177; $aif.'), ['aif-architecture', 'aif-roadmap', 'aif-plan', 'aif']);
});
test('commands inside code blocks work; other variables and embedded names do not match', () => {
  assert.deepEqual(extractAifCommands('```text\n$aif-plan\n```\n$aifhub $aif_analyze $$aif-plan foo$aif-plan /$aif-plan $HOME'), ['aif-plan']);
});

test('scoped commands in fenced blocks stop at LF or CRLF without disappearing or consuming the next line', () => {
  for (const newline of ['\n', '\r\n']) {
    const text = ['Прогресс остаётся 10/15. Теперь можно вернуться к задаче 3.3:', '', '```text',
      '$aif-implement 71-schedule-templates', '```', '',
      '::aif-chat{card="794dbf57-c2ed-4bbd-af7a-c62b75bf78bb" target="openspec/changes/71-schedule-templates/tasks.md" phase="fix"}'].join(newline);
    const reply = analyzeReply(text);
    assert.deepEqual(reply.ids, ['aif-implement']);
    assert.equal(reply.commands.get('aif-implement'), 'aif-implement 71-schedule-templates');
    assert.equal(reply.error, null);
    assert.deepEqual(extractAifInvocations('/aif-plan full "@docs/my plan.md"' + newline + 'Following prose'), [
      { id: 'aif-plan', command: 'aif-plan full "@docs/my plan.md"' },
    ]);
    assert.deepEqual(extractAifInvocations('$aif-implement demo \t' + newline + 'rm unrelated'), [
      { id: 'aif-implement', command: 'aif-implement demo' },
    ]);
    assert.deepEqual(extractAifInvocations('$aif-plan "unfinished' + newline + 'argument"'), []);
    assert.deepEqual(extractAifInvocations('$aif-plan ' + 'x'.repeat(4001) + newline), []);
  }
});
test('suggestions are bounded and do not turn following shell syntax into a command', () => {
  const commands = Array.from({ length: 20 }, (_, i) => `$aif-${i}`).join(' ');
  assert.equal(extractAifCommands(commands).length, 12);
  assert.deepEqual(extractAifCommands('$aif-review; rm -rf x && $aif-plan'), ['aif-review', 'aif-plan']);
  assert.deepEqual(extractAifCommands('x'.repeat(1024 * 1024) + ' $aif-plan'), []);
});

test('prefix-free invocations in complete code spans and fences retain arguments and reply order', () => {
  const reply = analyzeReply('Следующий шаг — `aif-fix 71-schedule-templates`. Коммит и push не выполнялись.');
  assert.deepEqual(reply.ids, ['aif-fix']);
  assert.equal(reply.commands.get('aif-fix'), 'aif-fix 71-schedule-templates');
  for (const command of ['`aif-review`', '``aif-review``', '```text\naif-review\n```', '~~~text\r\naif-review\r\n~~~~']) {
    assert.deepEqual(extractAifCommands(command), ['aif-review']);
  }
  assert.deepEqual(extractAifInvocations('``aif-fix "@docs/my plan.md" --plan-first``'), [
    { id: 'aif-fix', command: 'aif-fix "@docs/my plan.md" --plan-first' },
  ]);
  assert.deepEqual(extractAifInvocations('`aif-mode sync` затем `$aif-commit`, потом `aif-mode`.'), [
    { id: 'aif-mode', command: 'aif-mode sync' }, { id: 'aif-commit', command: 'aif-commit' },
  ]);
  assert.deepEqual(extractAifInvocations('```text\naif-fix demo && shell\naif-verify demo\n```'), [
    { id: 'aif-fix', command: 'aif-fix demo' }, { id: 'aif-verify', command: 'aif-verify demo' },
  ]);
});

test('prefix-free mentions outside command code, paths and incomplete code never become suggestions', () => {
  for (const text of ['aif-fix demo', 'Applied aif-fix.', '`skills/aif-fix/SKILL.md`', '`aif-fix.md`',
    '`https://example.org/aif-fix`', '`example aif-fix demo`', '`aif-fix demo', '```text\naif-fix demo',
    '```text\naif-fix demo\n~~', '`aif-fix "unfinished`', '`aif-fix ' + 'x'.repeat(4001) + '`']) {
    assert.deepEqual(extractAifInvocations(text), [], text.slice(0, 80));
  }
  const gate = { schema_version: 1, gate: 'rules', status: 'warn', blocking: false, blockers: [],
    affected_files: ['aif-archive'], suggested_next: { command: null, reason: 'aif-commit' } };
  assert.deepEqual(analyzeReply('```aif-gate-result\n' + JSON.stringify(gate) + '\n```').ids, []);
  assert.equal(extractAifCommands(Array.from({ length: 20 }, (_, i) => '`aif-' + i + '`').join(' ')).length, 12);
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

test('slash commands exclude paths, URLs and malformed prefixes and retain arguments only up to the invocation boundary', () => {
  assert.deepEqual(extractAifCommands('https://example.org/aif-review /tmp/aif-plan ./aif-fix //aif-commit $/aif-mode /$aif-plan /aifhub /aif_bad'), []);
  assert.deepEqual(extractAifInvocations('/aif-mode sync --force && shell'), [{ id: 'aif-mode', command: 'aif-mode sync --force' }]);
  for (const text of ['$aif-mode sync; shell', '/aif-mode sync, затем', '/aif-mode sync$(shell)']) {
    assert.deepEqual(extractAifInvocations(text), [{ id: 'aif-mode', command: 'aif-mode sync' }]);
  }
  assert.deepEqual(extractAifInvocations('/aif-mode\nsync'), [{ id: 'aif-mode', command: 'aif-mode' }]);
  assert.deepEqual(extractAifInvocations('/aif-plan full @secret #196'), [{ id: 'aif-plan', command: 'aif-plan full @secret #196' }]);
});

test('Markdown backticks terminate arguments and never become arguments or absorb following prose', () => {
  assert.deepEqual(extractAifInvocations('Далее `$aif-plan full #177`, затем `$aif-review +coupling`. Объяснение.'), [
    { id: 'aif-plan', command: 'aif-plan full #177' }, { id: 'aif-review', command: 'aif-review +coupling' },
  ]);
  assert.deepEqual(extractAifInvocations('``$aif-fix "@docs/my plan.md" --plan-first`` — пояснение'), [
    { id: 'aif-fix', command: 'aif-fix "@docs/my plan.md" --plan-first' },
  ]);
  assert.deepEqual(extractAifInvocations('`$aif-explore и что проверить?`'), [{ id: 'aif-explore', command: 'aif-explore и что проверить?' }]);
  assert.deepEqual(extractAifInvocations('`$aif-review`'), [{ id: 'aif-review', command: 'aif-review' }]);
  assert.deepEqual(extractAifInvocations('$aif-plan "unterminated\nNext line'), []);
  assert.deepEqual(extractAifInvocations('$aif-plan ' + 'x'.repeat(4001)), []);
});

test('gate JSON cannot supply prose arguments and an exact gate recommendation retains precedence', () => {
  const gate = { schema_version: 1, gate: 'rules', status: 'warn', blocking: false, blockers: [], affected_files: ['/aif-archive'],
    suggested_next: { command: '/aif-mode', reason: 'Example /aif-mode sync is data.' } };
  const reply = analyzeReply('/aif-mode sync\n```aif-gate-result\n' + JSON.stringify(gate) + '\n```');
  assert.equal(reply.error, null); assert.deepEqual(reply.ids, ['aif-mode']);
  assert.equal(reply.commands.get('aif-mode'), 'aif-mode');
});
