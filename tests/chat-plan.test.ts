import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatPlan } from '../chat-plan.ts';
import { nativePlanInput } from '../basic-workflow.ts';
import type { HistoryRow } from '../check-history.ts';

const request = (seq = 1, builtin = true) => ({ seq, type: 'client/turn/requested', data: {
  input: [builtin ? nativePlanInput('Составить план') : { type: 'text', text: '/plan demo', mentions: [] }],
} }) as HistoryRow;
const reply = (text: string, seq = 2, child = false) => ({ seq, type: 'item/completed', data: { item: {
  type: 'agentMessage', text, ...(child ? { parentToolCallId: 'child' } : {}),
} } }) as HistoryRow;
const text = '<proposed_plan>\n# New task\n\n1. Fix the input.\n2. Test offline.\nNo push.\n</proposed_plan>';

test('a complete root proposal after builtin Plan is scoped by message and content, including an old trailing card', () => {
  const plan = readChatPlan([request(), reply(text)])!;
  assert.equal(plan.title, 'New task'); assert.equal(plan.seq, 2); assert.equal(plan.hash.length, 64);
  assert.match(plan.text, /No push/); assert(!plan.text.includes('<proposed_plan>'));
  const oldCard = readChatPlan([request(), reply(text + '\n::aif-chat{card="old" phase="plan"}')])!;
  assert.equal(oldCard.hash, plan.hash);
  const document = readChatPlan([request(), reply('<proposed_plan>\n````aif-plan\n' + plan.text + '\n````\n</proposed_plan>')])!;
  assert.equal(document.hash, plan.hash); assert.equal(document.text, plan.text);
  assert.notEqual(readChatPlan([request(), reply(text.replace('offline', 'locally'))])!.hash, plan.hash);
  assert.equal(readChatPlan([request(), reply(text, 3)])!.seq, 3);
});

test('examples, incomplete or oversized plans and unrelated or newer requests cannot authorize execution', () => {
  for (const value of ['```xml\n' + text + '\n```', '> ' + text, 'Example:\n' + text,
    text.replace('</proposed_plan>', ''), text + '\nContinue?', text + text,
    '<proposed_plan> </proposed_plan>', '<proposed_plan>' + 'x'.repeat(96000) + '</proposed_plan>']) {
    assert.equal(readChatPlan([request(), reply(value)]), null);
  }
  assert.equal(readChatPlan([request(1, false), reply(text)]), null);
  assert.equal(readChatPlan([reply(text)]), null);
  assert.equal(readChatPlan([request(), reply(text, 2, true)]), null);
  assert.equal(readChatPlan([request(), reply(text), request(3)]), null);
  assert.equal(readChatPlan([request(), reply(text), reply('Done', 3)]), null);
});

test('a standalone aif-plan document after native Plan is saved just like a wrapped document', () => {
  const body = '# #193 — Убрать повторную работу Rust в CI\n\n## Tasks\n- [ ] 1. Split test sets\n\n```sh\ncargo test\n```';
  const fence = '````aif-plan\n' + body + '\n````';
  const plan = readChatPlan([request(), reply(fence)])!;
  assert.equal(plan.text, body); assert.equal(plan.seq, 2);
  assert.equal(plan.hash, readChatPlan([request(), reply('<proposed_plan>\n' + fence + '\n</proposed_plan>')])!.hash);
  assert.equal(readChatPlan([request(), reply(fence + '\n::aif-chat{phase="plan"}')])!.hash, plan.hash);
  for (const value of [body, 'Example:\n' + fence, fence + '\nContinue?', fence + '\n' + fence,
    fence.slice(0, -4), fence.replace('aif-plan', 'markdown'), '<proposed_plan>\n' + fence,
    '```markdown\n' + fence + '\n```']) {
    assert.equal(readChatPlan([request(), reply(value)]), null);
  }
  assert.equal(readChatPlan([request(1, false), reply(fence)]), null);
  assert.equal(readChatPlan([request(), reply(fence, 2, true)]), null);
  assert.equal(readChatPlan([request(), reply(fence), request(3)]), null);
});
