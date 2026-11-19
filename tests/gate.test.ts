import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyGate, blockedByGate } from '../gate.ts';
import { analyzeReply } from '../suggestions.ts';

export const gateBlock = (gate: object) => '```aif-gate-result\n' + JSON.stringify(gate) + '\n```';
export const warnGate = { schema_version: 1, gate: 'verify', status: 'warn', blocking: false, blockers: [], affected_files: ['src/demo.ts'], suggested_next: { command: '/aif-commit', reason: 'Only non-blocking warnings remain.' } };

test('slash and dollar recommendations have the same allowlist without changing the original gate', () => {
  for (const gate of ['verify', 'review', 'rules', 'security']) for (const prefix of ['/', '$']) {
    const command = `${prefix}aif-fix`;
    const parsed = analyzeReply(gateBlock({ ...warnGate, gate, suggested_next: { command, reason: 'Fix findings.' } }));
    assert.equal(parsed.error, null); assert.deepEqual(parsed.ids, ['aif-fix']);
    assert.equal(parsed.gate?.suggested_next?.command, command);
  }
});

test('security FAIL accepts dollar fix but still blocks advancement and shell-like commands', () => {
  const security = { ...warnGate, gate: 'security', status: 'fail', blocking: true,
    blockers: [{ id: 'security-dev-dependency-advisories', severity: 'error', file: 'package-lock.json', summary: 'Development dependency advisories remain.' }] };
  const parsed = analyzeReply(gateBlock({ ...security, suggested_next: { command: '$aif-fix', reason: 'Address advisories separately.' } }));
  assert.equal(parsed.error, null); assert.equal(parsed.gate?.blocking, true); assert.equal(parsed.gate?.blockers.length, 1);
  assert(blockedByGate('aif-commit', parsed.gate));
  for (const command of ['$aif-commit', '$aif-done', '$aif-fix && shell', '$$aif-fix', 'aif-fix', '$aif-fix\n/aif-commit']) {
    assert(analyzeReply(gateBlock({ ...security, suggested_next: { command, reason: 'Not allowed.' } })).error);
  }
});

test('PASS accepts an explanation with a null command without inventing an action', () => {
  const payload = { ...warnGate, gate: 'rules', status: 'pass', suggested_next: { command: null, reason: 'No explicit rule violations or rule updates required.' } };
  const reply = analyzeReply(gateBlock(payload));
  assert.equal(reply.error, null); assert.equal(reply.gate?.status, 'pass'); assert.deepEqual(reply.ids, []);
  assert.deepEqual(reply.gate?.suggested_next, payload.suggested_next);
  for (const command of ['/aif-rules', '', ' ']) assert(analyzeReply(gateBlock({ ...payload, suggested_next: { command, reason: 'Not an explanation-only result.' } })).error);
});
test('non-blocking verify WARN extracts the slash recommendation and its reason', () => {
  const reply = analyzeReply(gateBlock(warnGate));
  assert.equal(reply.error, null); assert.equal(reply.gate?.status, 'warn');
  assert.equal(reply.gate?.blocking, false); assert.deepEqual(reply.ids, ['aif-commit']);
  assert.equal(reply.gate?.suggested_next?.reason, warnGate.suggested_next.reason);
});
test('blocking findings retain stable ids, severity, summary and files; prose cannot bypass them', () => {
  const fail = { ...warnGate, status: 'fail', blocking: true, blockers: [{ id: 'verify-1', severity: 'error', file: 'src/demo.ts', summary: 'Required behavior is missing.' }], suggested_next: { command: '/aif-fix', reason: 'Fix the blocker.' } };
  const reply = analyzeReply('$aif-commit\n' + gateBlock(fail));
  assert.equal(reply.error, null); assert.deepEqual(reply.ids, ['aif-fix', 'aif-commit']);
  assert.equal(reply.gate?.blockers[0].summary, fail.blockers[0].summary);
  assert(blockedByGate('aif-commit', reply.gate)); assert(!blockedByGate('aif-fix', reply.gate));
});

test('review FAIL accepts blocker strings without losing findings or weakening routing', () => {
  const blockers = ['R1: TypeScript worker drops effective read_only restrictions from claim responses.',
    'R2: Deleted review target with preserved head is accepted by worker policy guard.'];
  const payload = { ...warnGate, gate: 'review', status: 'fail', blocking: true, blockers,
    suggested_next: { command: '$aif-fix', reason: 'Fix R1 and R2, add regression tests and rerun CI gate.' } };
  const reply = analyzeReply('$aif-commit\n' + gateBlock(payload));
  assert.equal(reply.error, null); assert.equal(reply.gate?.status, 'fail'); assert.equal(reply.gate?.blocking, true);
  assert.deepEqual(reply.gate?.blockers, blockers.map((summary, i) => ({ id: `R${i + 1}`, severity: 'error', summary: summary.slice(4) })));
  assert.deepEqual(reply.ids, ['aif-fix', 'aif-commit']);
  assert(blockedByGate('aif-commit', reply.gate)); assert(blockedByGate('aif-implement', reply.gate));
  assert(!blockedByGate('aif-fix', reply.gate)); assert.equal(payload.blockers[0], blockers[0]);
  const mixed = parseReplyGate(gateBlock({ ...payload, blockers: [blockers[0], 'Unlabelled blocker',
    { id: 'existing', severity: 'warning', summary: 'Explicit severity is retained.', file: 'src/demo.ts' }] }));
  assert.equal(mixed.error, null);
  assert.deepEqual(mixed.gate?.blockers[1], { id: 'blocker-2', severity: 'error', summary: 'Unlabelled blocker' });
  assert.deepEqual(mixed.gate?.blockers[2], { id: 'existing', severity: 'warning', summary: 'Explicit severity is retained.', file: 'src/demo.ts' });
});

test('string blocker compatibility preserves limits, contradictory states and next-step restrictions', () => {
  const fail = { ...warnGate, gate: 'review', status: 'fail', blocking: true, blockers: ['R1: Required behavior is missing.'],
    suggested_next: { command: '$aif-fix', reason: 'Fix findings.' } };
  for (const patch of [{ blockers: [''] }, { blockers: ['  '] }, { blockers: ['R1: '] },
    { blockers: ['x'.repeat(2001)] }, { blockers: Array(101).fill('Finding') }, { blockers: [false] },
    { blockers: [{ summary: 'Incomplete object is not repaired.' }] }, { blocking: false }, { status: 'pass' },
    { suggested_next: { command: '$aif-commit', reason: 'Bypass' } }, { schema_version: 2 }]) {
    assert(analyzeReply(gateBlock({ ...fail, ...patch })).error);
  }
});
test('last gate wins and data fields never become independent command suggestions', () => {
  const reply = analyzeReply(gateBlock(warnGate) + '\n' + gateBlock({ ...warnGate, affected_files: ['$aif-archive'], suggested_next: { command: '/aif-roadmap', reason: '$aif-commit is a quoted name, not another recommendation.' } }));
  assert.equal(reply.error, null); assert.deepEqual(reply.ids, ['aif-roadmap']);
});
test('invalid or unclosed final gate never falls back to an earlier valid result', () => {
  for (const tail of ['```aif-gate-result\nbad\n```', '```aif-gate-result\n{"status":']) {
    const reply = analyzeReply(gateBlock(warnGate) + '\n' + tail);
    assert(reply.error); assert.equal(reply.gate, null); assert.deepEqual(reply.ids, []);
  }
  const trailing = parseReplyGate(gateBlock(warnGate) + '\nmore text');
  assert.equal(trailing.error, null); assert(trailing.warning);
});

test('a valid review FAIL followed by a summary keeps findings and fix with a separate format warning', () => {
  const gate = { ...warnGate, gate: 'review', status: 'fail', blocking: true,
    blockers: [{ id: 'windows-project-path-prefix', severity: 'error', summary: 'Windows project paths use incompatible slash styles.' },
      { id: 'worker-failure-aborts-run-burns-attempts', severity: 'error', summary: 'A failed worker consumes sibling attempts.' }],
    suggested_next: { command: '$aif-fix', reason: 'Two blocking findings.' } };
  const reply = analyzeReply(gateBlock(gate) + '\n\nИтог: обе находки блокирующие. `$aif-commit` не выполнялся.');
  assert.equal(reply.error, null); assert(reply.warning); assert.deepEqual(reply.gate, gate);
  assert.deepEqual(reply.ids, ['aif-fix']); assert(!reply.prose.includes('Итог'));
  assert(!blockedByGate('aif-fix', reply.gate, reply.warning));
  assert(blockedByGate('aif-commit', reply.gate, reply.warning));
  assert.equal(parseReplyGate(gateBlock(gate)).warning, null);
});

test('a format warning cannot authorize PASS advancement or override content validation', () => {
  const pass = { ...warnGate, status: 'pass', suggested_next: null };
  const reply = analyzeReply('$aif-commit\n' + gateBlock(pass) + '\n/aif-fix');
  assert.equal(reply.error, null); assert(reply.warning); assert.equal(reply.gate?.status, 'pass');
  assert.deepEqual(reply.ids, ['aif-commit']);
  for (const id of ['aif-implement', 'aif-commit', 'aif-done', 'aif-archive']) assert(blockedByGate(id, reply.gate, reply.warning));
  assert(!blockedByGate('aif-verify', reply.gate, reply.warning));
  const invalid = parseReplyGate(gateBlock({ ...pass, blocking: true }) + '\nsummary');
  assert(invalid.error); assert.equal(invalid.warning, null);
});
test('nested or quoted examples are not authoritative gate results', () => {
  assert.equal(parseReplyGate('````markdown\n' + gateBlock(warnGate) + '\n````').gate, null);
  assert.equal(parseReplyGate(gateBlock(warnGate).split('\n').map(l => '> ' + l).join('\n')).gate, null);
});
test('contradictory states, arbitrary commands and gate-incompatible routing are diagnosed', () => {
  for (const patch of [
    { blocking: true }, { status: 'fail', blocking: true }, { status: 'pass' },
    { suggested_next: { command: '/aif-commit && shell', reason: 'bad' } },
    { gate: 'security' }, { schema_version: 2 },
    { blockers: [{ id: 'x', severity: 'critical', summary: 'bad severity' }] },
  ]) assert(analyzeReply(gateBlock({ ...warnGate, ...patch })).error);
});
test('PASS or FAIL with no next command still produces gate information, not invented suggestions', () => {
  const pass = analyzeReply(gateBlock({ ...warnGate, status: 'pass', suggested_next: null }));
  assert.equal(pass.error, null); assert.equal(pass.gate?.status, 'pass'); assert.deepEqual(pass.ids, []);
  const fail = analyzeReply(gateBlock({ ...warnGate, status: 'fail', blocking: true, blockers: [{ id: '1', severity: 'warning', summary: 'Policy escalates this finding.' }], suggested_next: null }));
  assert.equal(fail.error, null); assert.equal(fail.gate?.blockers.length, 1); assert.deepEqual(fail.ids, []);
});
