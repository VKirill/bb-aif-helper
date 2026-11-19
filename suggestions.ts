// Suggest installed skill names with either runtime prefix. A one-line inline
// code span keeps the full command with its arguments (up to 300 chars); prose
// keeps only the fixed "aif-mode sync" subcommand — other arguments are dropped.
import { parseReplyGate } from './gate.ts';
import type { Action, Suggestions } from './model.ts';

const SPAN_COMMAND = /^[/\$](aif(?:-[a-z0-9]+)*)(\s+\S.*)?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SPAN = /(?<!`)`([^`\n]+)`(?!`)/g;
const INVOCATION = /(?<![\w$\\/.-])[/$](aif(?:-[a-z0-9]+)*)(?![\w/-])/g;

export function extractAifInvocations(text: string): { id: string; command: string }[] {
  const bounded = text.slice(0, 1024 * 1024);
  const found = new Map<string, { id: string; command: string; pos: number; rank: number }>();
  const offer = (id: string, command: string, pos: number, rank: number) => {
    if (id.length > 100) return;
    const ex = found.get(id);
    const first = ex ? Math.min(ex.pos, pos) : pos;
    if (!ex || rank > ex.rank || (rank === ex.rank && pos < ex.pos)) found.set(id, { id, command, pos: first, rank });
    else ex.pos = first;
  };
  for (const match of bounded.matchAll(INVOCATION)) {
    const name = match[1];
    const tail = bounded.slice(match.index! + match[0].length);
    const command = name === 'aif-mode' && /^[ \t]+sync(?=$|[\s`.,;:!?)])/u.test(tail) ? 'aif-mode sync' : name;
    offer(name, command, match.index!, command === 'aif-mode sync' ? 1 : 0);
  }
  for (const match of bounded.matchAll(SPAN)) {
    const span = match[1].trim();
    if (span.length > 300 || CONTROL_CHARS.test(span)) continue;
    const parsed = SPAN_COMMAND.exec(span);
    if (parsed) offer(parsed[1], span.slice(1).replace(/\s+/g, ' '), match.index!, parsed[2] === undefined ? 0 : 2);
  }
  return [...found.values()].sort((a, b) => a.pos - b.pos).slice(0, 12).map(({ id, command }) => ({ id, command }));
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

// Chips write into the composer draft: bare commands that need the user's
// topic wait for text; a command that already carries arguments submits an
// empty draft right away and only edits a non-empty one.
export const TOPIC_COMMANDS = new Set(['aif-explore', 'aif-plan', 'aif-fix']);

const stripRanges = (text: string, ranges: readonly { from: number; to: number }[]) => {
  let out = '';
  let pos = 0;
  for (const m of ranges) { out += text.slice(pos, m.from); pos = Math.max(pos, m.to); }
  return out + text.slice(pos);
};

const isModePill = (m: { kind?: string; provider?: string; id?: string }) =>
  m.kind === 'plugin' && m.provider === 'aif-mode' && m.id === 'aif-mode';

/** True when the draft text, ignoring the AI Factory pill, starts with a `/` or `$` command. */
export function isCommandDraft(draft: { text: string; mentions: readonly { from: number; to: number; kind?: string; provider?: string; id?: string }[] }): boolean {
  const pills = draft.mentions.filter(isModePill).sort((a, b) => a.from - b.from);
  const text = stripRanges(draft.text, pills).trimStart();
  return text.startsWith('/') || text.startsWith('$');
}

export function chipDraft<M extends { from: number; to: number; kind?: string; provider?: string; id?: string }>(
  draft: { text: string; mentions: readonly M[] },
  command: string,
  id: string,
): { text: string; mentions: M[]; submit: boolean } {
  // The AI Factory mode pill never enters a command draft: BB would pass its
  // text to the skill as arguments, while commands read the mode from
  // skill-context. A draft holding only the pill counts as empty.
  const pills = draft.mentions.filter(isModePill).sort((a, b) => a.from - b.from);
  const hasArgs = /\s/.test(command.replace(/^[/\$][\w-]+/, ''));
  const empty = () => {
    const topic = TOPIC_COMMANDS.has(id) && !hasArgs;
    return { text: topic ? `${command} ` : command, mentions: [] as M[], submit: !topic };
  };
  const text = stripRanges(draft.text, pills);
  const unshift = (at: number) => pills.reduce((n, m) => n + (m.to <= at ? m.to - m.from : m.from < at ? at - m.from : 0), 0);
  const mentions = draft.mentions.filter(m => !isModePill(m)).map(m => ({ ...m, from: m.from - unshift(m.from), to: m.to - unshift(m.to) }));
  if (!text.trim()) return empty();
  const lead = /^\s*/.exec(text)![0].length;
  const body = text.slice(lead);
  const head = /^[/$][\w-]+/.exec(body);
  if (head) {
    const start = lead;
    const end = lead + head[0].length;
    const tail = text.slice(end);
    const overlaps = mentions.some(m => m.from < end && m.to > start);
    if (!overlaps) {
      if (!tail.trim() && !hasArgs) return empty();
      if (hasArgs) {
        const newline = text.indexOf('\n', end);
        const cut = newline === -1 ? text.length : newline;
        const delta = command.length - (cut - start);
        return {
          text: text.slice(0, start) + command + text.slice(cut),
          mentions: mentions.filter(m => m.to <= start || m.from >= cut)
            .map(m => m.from >= cut ? { ...m, from: m.from + delta, to: m.to + delta } : m),
          submit: false,
        };
      }
      const delta = command.length - head[0].length;
      return {
        text: text.slice(0, start) + command + tail,
        mentions: mentions.map(m => {
          const by = m.from >= end ? delta : 0;
          return { ...m, from: m.from + by, to: m.to + by };
        }),
        submit: true,
      };
    }
  }
  const shift = command.length + 1 - lead;
  return {
    text: hasArgs ? `${command}\n${body}` : `${command} ${body}`,
    mentions: mentions.map(m => ({ ...m, from: m.from + shift, to: m.to + shift })),
    submit: !hasArgs,
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
    return [{ id, command: `${o.prefix}${body}`, available: true, reason: 'Следующий шаг', probability: null }];
  }).filter(item => !o.hidden.includes(item.id)).slice(0, 3);
}
