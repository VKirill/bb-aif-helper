// Suggest installed skill names with either runtime prefix. Only the fixed
// "aif-mode sync" subcommand is retained; arbitrary arguments/prose are dropped.
import { parseReplyGate } from './gate.ts';
import type { Action, Suggestions } from './model.ts';

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

const stripRanges = (text: string, ranges: readonly { from: number; to: number }[]) => {
  let out = '';
  let pos = 0;
  for (const m of ranges) { out += text.slice(pos, m.from); pos = Math.max(pos, m.to); }
  return out + text.slice(pos);
};

export function chipDraft<M extends { from: number; to: number; kind?: string; provider?: string; id?: string }>(
  draft: { text: string; mentions: readonly M[] },
  command: string,
  id: string,
): { text: string; mentions: M[]; submit: boolean } {
  // The AI Factory mode pill marks the draft; it is not topic text. A draft
  // holding only it counts as empty, and the pill is kept after the command.
  const pills = draft.mentions
    .filter(m => m.kind === 'plugin' && m.provider === 'aif-mode' && m.id === 'aif-mode')
    .sort((a, b) => a.from - b.from);
  const empty = () => {
    const topic = TOPIC_COMMANDS.has(id);
    let text = topic ? `${command} ` : command;
    const mentions: M[] = [];
    for (const m of pills) {
      if (text && !text.endsWith(' ')) text += ' ';
      const from = text.length;
      text += draft.text.slice(m.from, m.to);
      mentions.push({ ...m, from, to: text.length });
    }
    if (topic && mentions.length) text += ' ';
    return { text, mentions, submit: !topic };
  };
  const lead = /^\s*/.exec(draft.text)![0].length;
  const body = draft.text.slice(lead);
  if (!stripRanges(draft.text, pills).trim()) return empty();
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

/**
 * Chips for a chat whose last reply names no AI Factory command (mode on): up to three available
 * `next` actions whose skill is installed, one per skill, in the runtime's prefix.
 */
export function nextStepItems(actions: readonly Action[], o: { skills: readonly string[]; invalid: boolean; prefix: '/' | '$'; hidden: readonly string[] }): Suggestions['items'] {
  if (o.invalid) return [];
  const seen = new Set<string>();
  return actions.filter(a => a.group === 'next' && a.available).flatMap(a => {
    const body = a.command.replace(/^[/$]/, '');
    const id = body.split(/\s/, 1)[0];
    if (seen.has(id) || !(o.skills.includes(id) || id === 'aif-chat')) return [];
    seen.add(id);
    return [{ id, command: `${o.prefix}${body}`, available: true, reason: 'Следующий шаг' }];
  }).filter(item => !o.hidden.includes(item.id)).slice(0, 3);
}
