import type { Snapshot } from './model.ts';
import type { HistoryRow } from './check-history.ts';
import { confirmationProse } from './confirmation.ts';

export const SESSION_BRIEF_COMMAND = 'aif-session-brief';
export type SessionBriefReport = { target: string; status: 'stale' | 'missing' | 'research' | 'invalid' | 'blocked' | 'valid' | 'fresh'; seq: number };
export const sessionBriefBlocked = (snapshot: Snapshot) => snapshot.profile === 'aifhub-openspec' && snapshot.target?.kind === 'openspec' && !!snapshot.sessionBrief
  && snapshot.sessionBrief.target === snapshot.target?.path && !['valid', 'fresh'].includes(snapshot.sessionBrief.status);
export const sessionBriefCommandAvailable = (snapshot: Snapshot) => snapshot.configured && snapshot.profile === 'aifhub-openspec'
  && snapshot.target?.kind === 'openspec' && !!snapshot.versions.globalCli
  && snapshot.extensions.some(e => e.name === 'aifhub-extension' && e.state === 'present' && e.commands?.includes('aifhub-session-brief'));
export const compileBriefCommand = (change: string) => `ai-factory aifhub-session-brief compile --change ${JSON.stringify(change)} --json`;
const cli = /(?<![\w/.-])ai-factory[ \t]+aifhub-session-brief[ \t]+compile[ \t]+--change[ \t]+(?:"([a-z0-9][a-z0-9._-]{0,199})"|'([a-z0-9][a-z0-9._-]{0,199})'|([a-z0-9][a-z0-9._-]{0,199}))[ \t]+--json(?=$|[\s`,;]|\.(?:$|\s))/g;
export function briefCommands(text: string) {
  return [...text.slice(0, 1024 * 1024).matchAll(cli)].map(match => ({ id: SESSION_BRIEF_COMMAND, command: match[0], change: match[1] ?? match[2] ?? match[3] }));
}
export function readSessionBrief(rows: HistoryRow[], target: Snapshot['target'], previous?: SessionBriefReport): SessionBriefReport | undefined {
  if (target?.kind !== 'openspec') return undefined;
  let result = previous?.target === target.path ? previous : undefined;
  let requested = false;
  let requestedCli = false;
  const scoped = (text: string) => {
    const explicit = [...text.matchAll(/--change(?:=|[ \t]+)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s`;,]+))/g)]
      .map(m => m[1] ?? m[2] ?? m[3]);
    if (explicit.length) return explicit.every(id => id === target.id);
    const launch = text.trim().match(/^[/$]aif-(?:implement|mode|improve)(?:[ \t]+([^\r\n]+))?(?:\r?\n|$)/);
    const argument = (launch?.[1] ?? '').trim().replace(/^"([^"]*)"$/, '$1').replace(/^@/, '');
    return !!launch && [target.id, target.path].includes(argument);
  };
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.type === 'client/turn/requested') {
      const input = row.data.input.filter(p => p.type === 'text' && p.visibility !== 'agent-only').map(p => p.type === 'text' ? p.text : '').join('\n');
      requested = scoped(input);
      requestedCli = requested && /^ai-factory\s+aifhub-session-brief\s+(?:compile|status)\b/.test(input.trim());
    } else if (row.type === 'item/completed' && row.data.item.type === 'agentMessage' && !row.data.item.parentToolCallId) {
      const text = row.data.item.text;
      if (result && result.seq >= row.seq) continue;
      if (text.includes('--change') ? !scoped(text) : !requested) continue;
      const prose = confirmationProse(text.replace(/`(valid|fresh)`/gi, '$1'));
      const statuses = [...prose.matchAll(/\bsession\s*brief\s*:\s*(stale|missing|research|invalid|blocked|valid|fresh)\b/g)].map(m => m[1]);
      // The compiler owner often summarizes a real recheck in natural language,
      // rather than spelling a literal "SessionBrief: valid" status line.
      if (requestedCli) for (const paragraph of prose.split(/\n\s*\n/)) {
        if (!/\bsession\s*brief\b/.test(paragraph) || /(?:^|\n)\s*(?:пример|образец|example|ожидаем)/u.test(paragraph)) continue;
        const issue = paragraph.match(/\bsession\s*brief\s+#(\d+)\b/);
        if (issue && target.id !== issue[1] && !target.id.startsWith(issue[1] + '-')) continue;
        const verified = paragraph.match(/(?:(?<![\p{L}\p{N}_])(?:повторная\s+|текущая\s+)?проверка\s+(?:подтвердила|вернула|показала)\s+(?:статус\s+)?|\b(?:recheck|verification|status check)\s+(?:confirmed|returned)\s+(?:status\s+)?)(valid|fresh)\b/u);
        if (verified && !/\b(?:valid|fresh)\s+(?:не\s+подтвержд|не\s+получен|not\s+confirmed)/u.test(paragraph)) statuses.push(verified[1]);
      }
      if (requestedCli) for (const block of text.slice(0, 1024 * 1024).matchAll(/^```(?:json)?\s*\r?\n([\s\S]*?)^```\s*$/gm)) {
        try {
          const value = JSON.parse(block[1]);
          if (value.change_id !== target.id || value.paths?.json !== `.ai-factory/state/${target.id}/context/session-brief.json`) continue;
          if (value.status === 'valid' && value.ok === true && /^[a-f0-9]{64}$/.test(value.digest ?? '') && Array.isArray(value.stale_reasons) && !value.stale_reasons.length) statuses.push('valid');
          else if (value.ok === false && ['stale', 'missing', 'blocked', 'invalid'].includes(value.status)) statuses.push(value.status);
        } catch { /* Malformed/example JSON is not a context report. */ }
      }
      const blocked = statuses.filter(status => !['fresh', 'valid'].includes(status));
      if (statuses.length) result = { target: target.path,
        status: (blocked.length ? blocked[0] : statuses[0]) as SessionBriefReport['status'], seq: row.seq };
    }
  }
  return result;
}
