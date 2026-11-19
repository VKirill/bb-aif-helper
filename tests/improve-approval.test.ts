import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingImproveProposal } from '../improve-approval.ts';
import { asksToApplyPlanChanges, pendingConfirmation } from '../confirmation.ts';
import type { HistoryRow } from '../check-history.ts';
import { snapshot } from './fixtures.ts';

const target = snapshot().target!;
const request = (seq: number, text = '/aif-improve demo') => ({ seq, type: 'client/turn/requested', data: { input: [{ type: 'text', text }] } }) as HistoryRow;
const reply = (seq: number, text: string, nested = false) => ({ seq, type: 'item/completed', data: { item: { type: 'agentMessage', text,
  ...(nested ? { parentToolCallId: 'child' } : {}) } } }) as HistoryRow;
const question = 'Для `demo` подготовлен diff уточнения задачи.\n**Применить этот diff к `design.md` и `tasks.md`?**\nПодтверждение требует установленный aif-improve: «never apply changes without user confirmation». Пока изменено только предложение; план и код сохранены.';

test('the improve apply-diff question creates a confirmation barrier and a plan-bound proposal', () => {
  const rows = [request(1), reply(2, question)];
  assert(asksToApplyPlanChanges(question)); assert(pendingConfirmation(rows));
  const proposal = pendingImproveProposal(rows, question, target)!;
  assert.equal(proposal.seq, 2); assert.equal(proposal.target, target.path);
  assert.match(proposal.command, /Применить все предложенные/); assert.match(proposal.command, /выполнение плана не запускать/);
  assert(!proposal.command.includes('aif-improve'));
  assert(pendingImproveProposal([request(1, '$aif-improve "@' + target.path + '"'), reply(2, question)], question, target));
  assert(asksToApplyPlanChanges('Apply the proposed changes to the plan?'));
});

test('apply-all never derives from another skill, another plan, examples, an old answer or a child agent', () => {
  for (const text of ['Подтверждаете такой объём?', 'Применены все улучшения плана.', '> Применить этот diff?',
    '```text\nПрименить этот diff?\n```', 'Пример: «Применить этот diff?»']) assert(!asksToApplyPlanChanges(text));
  for (const rows of [[request(1, '/aif-plan demo'), reply(2, question)], [request(1, '/aif-improve another-plan'), reply(2, question)],
    [request(1), reply(2, question), request(3, 'Не применять')], [request(1), reply(2, question, true)],
    [request(1), reply(2, question), reply(3, 'Готово.')], [reply(2, question)]]) {
    assert.equal(pendingImproveProposal(rows, question, target), null);
  }
  assert.equal(pendingImproveProposal([request(1), reply(2, question)], question, null), null);
});
