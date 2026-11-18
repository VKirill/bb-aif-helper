import type { HistoryRow } from './check-history.ts';

// This is a navigation hint, never evidence that the user granted permission.
// Ignore examples, quoted instructions and machine-readable blocks.
export function confirmationProse(text: string): string {
  let fence: { character: string; length: number } | null = null;
  const prose: string[] = [];
  for (const line of text.slice(0, 1024 * 1024).split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = null;
      continue;
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; continue; }
    if (/^\s*>|^(?: {4}|\t)|^\s*::aif-chat\{/.test(line)) continue;
    prose.push(line);
  }
  return prose.join('\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/(`+)[\s\S]*?\1/g, '').replace(/«[^»]*»|“[^”]*”|"[^"\n]*"/g, '')
    .replace(/[*_]/g, '').toLowerCase().replace(/ё/g, 'е').slice(-16000);
}
const applyQuestion = (value: string) => /(?:^|[.!?\n])\s*(?:применить|применяем|применим|внести|вносим)[^.!?\n]{0,200}(?:diff|дифф|изменени|улучшени|правк|все)[^.!?\n]{0,200}\?/u.test(value)
  || /(?:^|[.!?\n])\s*подтвердите\s+применение[^.!?\n]{0,200}(?:diff|изменени|улучшени|правк)/u.test(value)
  || /(?:^|[.!?\n])\s*(?:(?:shall|should|can) i |do you want me to )?apply[^.!?\n]{0,200}(?:diff|changes|improvements|all)[^.!?\n]{0,200}\?/u.test(value);
export const asksToApplyPlanChanges = (text: string) => applyQuestion(confirmationProse(text));
export function asksForConfirmation(text: string): boolean {
  const value = confirmationProse(text);
  return applyQuestion(value) || /(?:^|[.!?\n])\s*(?:пожалуйста[,\s]+)?(?:вы\s+)?(?:подтверждаете|подтвердите|согласуете|согласуйте|одобряете|одобрите)(?:[^.!?\n]{0,240}\?|[^.!?\n]{0,240}(?:объем|границ|исследован|план|действи|продолж|запуск|начал|публикац|релиз|изменени|исправлени|scope))/u.test(value)
    || /(?:^|[.!?\n])\s*(?:я\s+)?(?:жду|ожидаю)\s+(?:вашего\s+)?(?:явного\s+)?(?:подтверждения|согласования|разрешения)/u.test(value)
    || /(?:^|[.!?\n])\s*(?:можно\s+(?:ли\s+)?|разрешаете\s+)(?:мне\s+)?(?:начать|продолжить|приступить|выполнить)[^.!?\n]{0,240}\?/u.test(value)
    || /(?:^|[.!?\n])\s*(?:please\s+confirm|do you (?:confirm|approve))[^.!?\n]{0,240}(?:scope|plan|research|proceed|start|action)/u.test(value)
    || /(?:^|[.!?\n])\s*(?:(?:i am|i'm) waiting for (?:your |explicit )?(?:approval|confirmation)|(?:may|shall|can) i (?:proceed|start|continue)[^.!?\n]{0,240}\?)/u.test(value);
}

export function pendingConfirmation(rows: HistoryRow[]): boolean {
  // A newer user turn clears an old question immediately, including a refusal
  // or a clarification. Interpreting that answer remains the agent's job.
  for (const row of [...rows].sort((a, b) => b.seq - a.seq)) {
    if (row.type === 'client/turn/requested') return false;
    if (row.type !== 'item/completed' || row.data.item.type !== 'agentMessage' || row.data.item.parentToolCallId) continue;
    const text = row.data.item.text;
    if (!text.replace(/::aif-chat\{[^\n]*\}/g, '').trim()) continue;
    return asksForConfirmation(text);
  }
  return false;
}
