import type { HistoryRow } from './check-history.ts';
import type { Snapshot } from './model.ts';
import { asksToApplyPlanChanges } from './confirmation.ts';

export const IMPROVE_APPROVAL = 'apply-improvements';
export function pendingImproveProposal(rows: HistoryRow[], output: string | null, target: Snapshot['target']) {
  if (!target || target.kind === 'basic' || target.kind === 'fix' || !output || !asksToApplyPlanChanges(output)) return null;
  const ordered = [...rows].sort((a, b) => b.seq - a.seq);
  const latest = ordered.find(row => row.type === 'client/turn/requested' || row.type === 'item/completed'
    && row.data.item.type === 'agentMessage' && !row.data.item.parentToolCallId
    && row.data.item.text.replace(/::aif-chat\{[^\n]*\}/g, '').trim());
  if (latest?.type !== 'item/completed' || latest.data.item.type !== 'agentMessage'
    || latest.data.item.text.trim() !== output.trim()) return null;
  const request = ordered.find(row => row.type === 'client/turn/requested' && row.seq < latest.seq);
  if (request?.type !== 'client/turn/requested') return null;
  const text = request.data.input.filter(part => part.type === 'text' && part.visibility !== 'agent-only')
    .map(part => part.type === 'text' ? part.text : '').join('\n').trim();
  const launch = text.match(/^[/$]aif-improve(?:[ \t]+([^\r\n]+))?(?:\r?\n|$)/);
  if (!launch) return null;
  const argument = (launch[1] ?? '').trim().replace(/^(?:"([^"]*)"|'([^']*)')$/, '$1$2').replaceAll('\\', '/').replace(/^@/, '');
  // An explicit launch for another plan never inherits the currently selected tab.
  const names = [target.id, target.path, target.path.replace(/\/(?:tasks|index)\.md$/, '')];
  if (argument ? !names.includes(argument) : !names.some(name => output.includes(name))) return null;
  return { seq: latest.seq, target: target.path,
    command: `Применить все предложенные в предыдущем ответе улучшения плана ${JSON.stringify(target.id)}. Только предложенные правки; выполнение плана не запускать. Если diff изменился, покажи новое предложение и запроси подтверждение.` };
}
