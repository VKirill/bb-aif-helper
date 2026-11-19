import test from 'node:test';
import assert from 'node:assert/strict';
import { asksForConfirmation, pendingConfirmation } from '../confirmation.ts';
import type { HistoryRow } from '../check-history.ts';

const message = (seq: number, text: string, nested = false) => ({ seq, type: 'item/completed',
  data: { item: { type: 'agentMessage', text, ...(nested ? { parentToolCallId: 'child' } : {}) } } }) as HistoryRow;
const request = (seq: number) => ({ seq, type: 'client/turn/requested', data: { input: [{ type: 'text', text: 'нет, другой объём' }] } }) as HistoryRow;

test('recognizes an explicit scope question after preliminary exploration and direct approval requests', () => {
  for (const text of [
    'Предлагаю исследовать ограничения формы и сервера. **Подтверждаете такой объём?**\nУстановленный aif-explore требует подтверждения, поэтому выполнена только предварительная проверка.\n::aif-chat{phase="explore"}',
    'Подтверждаете такой объем?', 'Подтвердите, пожалуйста, план исследования.',
    'Жду вашего явного подтверждения перед началом исследования.', 'Ожидаю подтверждения.',
    'Можно ли начать исследование?', 'Разрешаете продолжить выполнение?',
    'Please confirm this scope before I start.', 'Do you approve this plan?', 'May I proceed?',
  ]) assert.equal(asksForConfirmation(text), true, text);
});

test('quoted instructions, examples, gate data and ordinary questions do not create a confirmation barrier', () => {
  for (const text of [
    'Исследование завершено. Следующий шаг — составить план.',
    'Объём подтверждён. Подтверждение не требуется.', 'Какие файлы изменились?',
    'Пример: «Подтверждаете такой объём?»', '"Подтверждаете такой объём?"',
    '> Подтверждаете такой объём?\n\nИсследование завершено.',
    '`Подтверждаете такой объём?`', '    Подтверждаете такой объём?',
    '```text\nПодтверждаете такой объём?\n```\nГотово.',
    '~~~~\nЖду вашего подтверждения.\n~~~~\nГотово.',
    '````md\n```\nПодтверждаете такой объём?\n```\n````\nГотово.',
    '<!--\nЖду подтверждения.\n-->\nГотово.',
    '```aif-gate-result\n{"suggested_next":{"reason":"Подтвердите объем исследования"}}\n```',
  ]) assert.equal(asksForConfirmation(text), false, text);
});

test('confirmation belongs only to the latest unanswered root reply, not an old turn or a child agent', () => {
  const question = message(2, 'Подтверждаете такой объём?');
  assert.equal(pendingConfirmation([question, request(1)]), true);
  assert.equal(pendingConfirmation([question, request(3)]), false);
  assert.equal(pendingConfirmation([question, message(4, 'Исследование закончено.')]), false);
  assert.equal(pendingConfirmation([message(5, 'Жду подтверждения.', true), message(4, 'Готово.')]), false);
  assert.equal(pendingConfirmation([message(3, '::aif-chat{phase="explore"}'), question, request(1)]), true);
  assert.equal(pendingConfirmation([]), false);
});
