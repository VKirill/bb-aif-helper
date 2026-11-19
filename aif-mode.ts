export const AIF_MENTION = { provider: 'aif-mode', id: 'aif-mode', label: 'AI Factory' } as const;

export function aifModeInstructions(): string {
  return [
    '## AI Factory mode',
    'This project is run through AI Factory.',
    'At the start read `.ai-factory/DESCRIPTION.md` and `.ai-factory/ARCHITECTURE.md` (or the paths in `.ai-factory/config.yaml` → `paths`).',
    'Drive work with `/aif-plan` → `/aif-implement` → `/aif-verify` → `/aif-commit`; fix bugs with `/aif-fix`.',
    'Follow the rules in `.ai-factory/skill-context/`.',
    'Call `aif_chat_status` at workflow boundaries.',
    'This is the default path; a direct owner request to do otherwise wins.',
  ].join('\n');
}

export function shouldContribute(input: { enabled: boolean; modeOn: boolean; parentThreadId: string | null }): boolean {
  return input.enabled && input.modeOn && input.parentThreadId === null;
}

const MENTION_TERMS = ['ai factory', 'aif', 'factory', 'фабрика', 'режим'];
/** Mention menu rows for a query: the mode pill when the query is empty or starts one of its terms. */
export function aifMentionItems(query: string) {
  const q = query.trim().toLowerCase();
  return !q || MENTION_TERMS.some(term => term.startsWith(q))
    ? [{ id: AIF_MENTION.id, title: 'AI Factory — режим работы', subtitle: 'Вести задачу через /aif-plan → /aif-implement → /aif-verify', icon: 'Workflow' }]
    : [];
}
