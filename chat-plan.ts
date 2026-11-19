import { createHash } from 'node:crypto';
import type { HistoryRow } from './check-history.ts';

/** A complete proposal from the root assistant after BB's builtin Plan action. */
export function readChatPlan(rows: HistoryRow[]) {
  const withoutCard = (text: string) => text.trim().replace(/(?:^|\r?\n)::aif-chat\{[^\r\n]*\}$/, '').trim();
  const ordered = [...rows].sort((a, b) => b.seq - a.seq);
  const latest = ordered.find(row => row.type === 'client/turn/requested' || row.type === 'item/completed'
    && row.data.item.type === 'agentMessage' && !row.data.item.parentToolCallId
    && withoutCard(row.data.item.text));
  if (latest?.type !== 'item/completed' || latest.data.item.type !== 'agentMessage') return null;
  const request = ordered.find(row => row.type === 'client/turn/requested' && row.seq < latest.seq);
  if (request?.type !== 'client/turn/requested' || !request.data.input.some(part => part.type === 'text'
    && part.visibility !== 'agent-only' && part.mentions?.some(mention => mention.start === 0 && mention.end === 5
      && part.text.slice(0, 5) === '/plan' && mention.resource.kind === 'command'
      && mention.resource.origin === 'builtin' && mention.resource.name === 'plan'))) return null;
  const text = withoutCard(latest.data.item.text);
  if (text.length > 96000) return null;
  const match = text.match(/^<proposed_plan>\s*([\s\S]+?)\s*<\/proposed_plan>$/);
  const inner = (match?.[1] ?? text).trim();
  if (/<\/?proposed_plan>/.test(inner)) return null;
  const fence = inner.match(/^(`{3,})aif-plan[^\S\r\n]*\r?\n([\s\S]+)\r?\n\1$/);
  // Native Plan can return the document fence directly, without XML markers.
  if (!match && !fence) return null;
  if (fence && new RegExp('^`{' + fence[1].length + ',}[^\\S\\r\\n]*$', 'm').test(fence[2])) return null;
  const body = (fence?.[2] ?? inner).trim();
  if (!body || Buffer.byteLength(body, 'utf8') > 96000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body)) return null;
  const title = (body.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? 'План из ответа').slice(0, 240);
  return { seq: latest.seq, hash: createHash('sha256').update(body).digest('hex'), title, text: body };
}

export type ChatPlanRecord = NonNullable<ReturnType<typeof readChatPlan>> & { environmentId: string; root: string };
