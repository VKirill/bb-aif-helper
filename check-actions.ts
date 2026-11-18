import type { Snapshot } from './model.ts';

export const rowActions: Record<string, string> = {
  verify: 'check-verify', rules: 'check-rules', security: 'check-security', review: 'check-review',
  'qa-plan': 'qa-prepare', qa: 'qa-run', quality: 'quality', ci: 'ci', readiness: 'done',
  mode: 'check-mode',
  worktree: 'check-worktree',
  coupling: 'check-coupling',
};
export const supplementaryChecks = new Set(['rules', 'security', 'review', 'qa-plan', 'qa', 'quality', 'ci', 'mode', 'worktree', 'completion-hook', 'coupling']);
const commands: Record<string, string> = {
  'aif-verify': 'verify', 'aif-rules-check': 'rules', 'aif-security-checklist': 'security', 'aif-review': 'review',
};
export const unchangedReason = 'Файлы не изменились с момента фиксации результата этой проверки. Повторный запуск не требуется.';
export function unchangedCheck(snapshot: Snapshot, skill: string, command = skill) {
  if (/(?:^|\s)\+coupling(?:$|\s)/.test(command)) return false; // A plain review is not proof of a coupling review.
  return snapshot.checks.some(check => check.id === commands[skill] && check.chat?.freshness === 'unchanged');
}
export function lockUnchangedChecks(snapshot: Snapshot) {
  for (const action of snapshot.actions) {
    const skill = action.command.match(/^[/$](aif(?:-[a-z0-9]+)*)\b/)?.[1];
    if (skill && action.available && unchangedCheck(snapshot, skill, action.command)) {
      action.available = false; action.disabledReason = 'unchanged'; action.reason = unchangedReason;
    }
  }
}
