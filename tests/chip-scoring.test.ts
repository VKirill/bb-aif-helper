import test from 'node:test';
import assert from 'node:assert/strict';
import { DECISIONS_URL, decisionsRequest, decisionsResponseSchema, probabilitiesFor, scoringKey } from '../chip-scoring.ts';

const candidates = [
  { id: 'aif-verify', command: '/aif-verify' },
  { id: 'aif-plan', command: '/aif-plan full #1' },
  { id: 'aif-gone', command: '/aif-gone' },
];

// Live response captured from a real Decisions API call.
const live = {
  answers: { next: { type: 'choice', choice: 'aif-verify', confidence: 0.994,
    probabilities: { 'aif-verify': 0.994, 'aif-plan': 0.0013, 'aif-commit': 0.0047 } } },
  usage: { total_input_tokens: 142, total_output_tokens: 0 },
};

test('decisionsRequest builds the gemini-decision-1 choice body and truncates the reply', () => {
  const body = decisionsRequest('x'.repeat(25_000), candidates);
  assert.equal(DECISIONS_URL, 'https://generativelanguage.googleapis.com/v1beta/decisions');
  assert.equal(body.model, 'gemini-decision-1');
  assert.equal(body.input.length, 20_000);
  assert.equal(body.questions.next.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.next.criteria), ['aif-verify', 'aif-plan', 'aif-gone']);
});

test('criteria pair the full command with a skill hint, or stay bare without one', () => {
  const { criteria } = decisionsRequest('reply', candidates).questions.next;
  assert.equal(criteria['aif-verify'], '/aif-verify — verify implementation against the plan');
  assert.equal(criteria['aif-plan'], '/aif-plan full #1 — plan new work');
  assert.equal(criteria['aif-gone'], '/aif-gone');
});

test('decisionsResponseSchema accepts the live response and keeps extra fields', () => {
  const parsed = decisionsResponseSchema.parse(live);
  assert.equal(parsed.answers?.next?.probabilities?.['aif-verify'], 0.994);
  assert.equal((parsed as Record<string, unknown>).usage !== undefined, true);
  assert.throws(() => decisionsResponseSchema.parse({ answers: { next: { probabilities: { 'aif-verify': 1.5 } } } }));
});

test('probabilitiesFor maps requested ids, defaults missing to 0 and drops unknown extras', () => {
  const response = decisionsResponseSchema.parse(live);
  assert.deepEqual(probabilitiesFor(response, ['aif-verify', 'aif-plan', 'aif-fix']),
    { 'aif-verify': 0.994, 'aif-plan': 0.0013, 'aif-fix': 0 });
  assert.deepEqual(probabilitiesFor(decisionsResponseSchema.parse({}), ['aif-verify']), {});
  assert.deepEqual(probabilitiesFor(decisionsResponseSchema.parse({ answers: {} }), ['aif-verify']), {});
});

test('scoringKey is stable under id order and sensitive to sourceKey', () => {
  assert.equal(scoringKey('abc', ['aif-verify', 'aif-plan']), scoringKey('abc', ['aif-plan', 'aif-verify']));
  assert.equal(scoringKey('abc', ['b', 'a', 'a']), 'abc|a,a,b');
  assert.notEqual(scoringKey('abc', ['a']), scoringKey('abd', ['a']));
});
