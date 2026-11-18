import type { Snapshot } from './model.ts';

export const GATE_EVIDENCE_COMMAND = 'aif-gate-evidence';
const cliName = 'aifhub-write-gate-evidence';
export const gateEvidenceCommandAvailable = (snapshot: Snapshot) => snapshot.configured && snapshot.profile === 'aifhub-openspec'
  && snapshot.target?.kind === 'openspec' && !!snapshot.versions.globalCli
  && snapshot.extensions.some(e => e.name === 'aifhub-extension' && e.state === 'present' && e.commands?.includes(cliName));

/** A recommendation is sent literally to the agent, never executed by the plugin. */
export function gateEvidenceCommands(text: string) {
  const result: { id: string; command: string; change: string; gate: string; placeholder: boolean }[] = [];
  for (const match of text.slice(0, 1024 * 1024).matchAll(/(?<![\w/.-])ai-factory[ \t]+aifhub-write-gate-evidence(?=[ \t])([^\r\n`]*)/g)) {
    const tail = match[1].trimEnd();
    if (tail.length > 4000) continue;
    const values = new Map<string, string>();
    let offset = 0;
    let valid = true;
    for (const option of tail.matchAll(/[ \t]+(?:(--change|--gate|--from)[ \t]+("[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`]+)|(--json|--force))/g)) {
      const key = option[1] ?? option[3];
      const raw = option[2] ?? '';
      const value = /^['"]/.test(raw) ? raw.slice(1, -1) : raw;
      if (option.index !== offset || values.has(key) || value.length > 1000) { valid = false; break; }
      values.set(key, value); offset += option[0].length;
    }
    const change = values.get('--change') ?? '';
    const gate = values.get('--gate') ?? '';
    const from = values.get('--from') ?? '';
    const placeholder = /^<[\w./-]+>$/.test(from);
    if (!valid || offset !== tail.length || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(change)
      || !['verify', 'review', 'security', 'rules'].includes(gate) || !from || from.startsWith('--')
      || /[\x00-\x1f;&|$]/.test(from) || !placeholder && /[<>]/.test(from)) continue;
    result.push({ id: GATE_EVIDENCE_COMMAND, command: match[0].slice(0, match[0].length - match[1].length) + tail, change, gate, placeholder });
    if (result.length === 12) break;
  }
  return result;
}
