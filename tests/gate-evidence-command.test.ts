import test from 'node:test';
import assert from 'node:assert/strict';
import { gateEvidenceCommands, GATE_EVIDENCE_COMMAND } from '../gate-evidence-command.ts';
import { analyzeReply } from '../suggestions.ts';

const prefix = 'ai-factory aifhub-write-gate-evidence';
test('writer recommendations keep exact arguments and distinguish a placeholder from an actual report', () => {
  const command = prefix + ' --change latest-review-approval --gate rules --from <rules-output.md>';
  const reply = analyzeReply('Сохраните результат, затем `$aif-verify latest-review-approval`:\n```text\n' + command + '\n```');
  assert.deepEqual(reply.ids, [GATE_EVIDENCE_COMMAND, 'aif-verify']);
  assert.equal(reply.commands.get(GATE_EVIDENCE_COMMAND), command);
  assert.deepEqual(reply.evidenceCommands[0], { id: GATE_EVIDENCE_COMMAND, command, change: 'latest-review-approval', gate: 'rules', placeholder: true });
  const scoped = prefix + ' --gate review --from "@docs/my report.md" --change "demo" --json --force';
  assert.equal(gateEvidenceCommands('`' + scoped + '`')[0].command, scoped);
  assert.equal(gateEvidenceCommands(scoped)[0].placeholder, false);
});

test('writer discovery never invents required arguments or absorbs shell syntax and gate data', () => {
  for (const tail of [' --change demo --gate rules', ' --gate rules --from out.md', ' --change demo --from out.md',
    ' --change demo --gate done --from out.md', ' --change demo --gate rules --from "unfinished',
    ' --change demo --gate rules --from out.md && shell', ' --change demo --gate rules --from out.md --unknown',
    ' --change demo --change other --gate rules --from out.md', ' --change demo --gate rules --from $(secret)',
    ' --change demo --gate rules --from ' + 'x'.repeat(1001)]) {
    assert.deepEqual(gateEvidenceCommands(prefix + tail), []);
  }
  assert.deepEqual(gateEvidenceCommands('https://example.org/' + prefix + ' --change demo --gate rules --from out.md'), []);
  const gate = { schema_version: 1, gate: 'rules', status: 'pass', blocking: false, blockers: [], affected_files: [],
    suggested_next: { command: null, reason: prefix + ' --change demo --gate rules --from out.md' } };
  assert.deepEqual(analyzeReply('```aif-gate-result\n' + JSON.stringify(gate) + '\n```').evidenceCommands, []);
});
