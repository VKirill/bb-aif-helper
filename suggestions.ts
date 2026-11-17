// Suggest installed skill names with either runtime prefix. Only the fixed
// "aif-mode sync" subcommand is retained; arbitrary arguments/prose are dropped.
import { parseReplyGate } from './gate.ts';

export function extractAifInvocations(text: string): { id: string; command: string }[] {
  const result: { id: string; command: string }[] = [];
  const bounded = text.slice(0, 1024 * 1024);
  for (const match of bounded.matchAll(/(?<![\w$\\/.-])[/$](aif(?:-[a-z0-9]+)*)(?![\w/-])/g)) {
    const name = match[1];
    const tail = bounded.slice(match.index! + match[0].length);
    const command = name === 'aif-mode' && /^[ \t]+sync(?=$|[\s`.,;:!?)])/u.test(tail) ? 'aif-mode sync' : name;
    const existing = result.find(item => item.id === name);
    if (existing && command === 'aif-mode sync') existing.command = command;
    else if (name.length <= 100 && !existing) result.push({ id: name, command });
    if (result.length === 12) break;
  }
  return result;
}
export function extractAifCommands(text: string): string[] {
  return extractAifInvocations(text).map(item => item.id);
}
export function analyzeReply(text: string) {
  const parsed = parseReplyGate(text);
  const next = !parsed.error ? parsed.gate?.suggested_next?.command?.slice(1) : null;
  const invocations = extractAifInvocations(parsed.prose);
  const commands = new Map(invocations.map(item => [item.id, item.command]));
  if (next) commands.set(next, next); // Gate's allowlist remains authoritative.
  const ids = [...new Set([...(next ? [next] : []), ...invocations.map(item => item.id)])].slice(0, 12);
  return { ...parsed, ids, next, commands };
}

// Chips write into the composer draft: commands that need the user's topic
// wait for text, everything else submits the composer draft right away.
export const TOPIC_COMMANDS = new Set(['aif-explore', 'aif-plan', 'aif-fix']);

export function chipDraft<M extends { from: number; to: number }>(
  draft: { text: string; mentions: readonly M[] },
  command: string,
  id: string,
): { text: string; mentions: M[]; submit: boolean } {
  const empty = () => TOPIC_COMMANDS.has(id)
    ? { text: `${command} `, mentions: [] as M[], submit: false }
    : { text: command, mentions: [] as M[], submit: true };
  const lead = /^\s*/.exec(draft.text)![0].length;
  const body = draft.text.slice(lead);
  if (!body.trim()) return empty();
  const head = /^[/$][\w-]+/.exec(body);
  if (head) {
    const start = lead;
    const end = lead + head[0].length;
    const tail = draft.text.slice(end);
    const overlaps = draft.mentions.some(m => m.from < end && m.to > start);
    if (!overlaps) {
      if (!tail.trim()) return empty();
      const delta = command.length - head[0].length;
      return {
        text: draft.text.slice(0, start) + command + tail,
        mentions: draft.mentions.map(m => {
          const by = m.from >= end ? delta : 0;
          return { ...m, from: m.from + by, to: m.to + by };
        }),
        submit: true,
      };
    }
  }
  const shift = command.length + 1 - lead;
  return {
    text: `${command} ${body}`,
    mentions: draft.mentions.map(m => ({ ...m, from: m.from + shift, to: m.to + shift })),
    submit: true,
  };
}
