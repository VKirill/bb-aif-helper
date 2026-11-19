export const supportsAif222 = (version: string | null) => {
  const match = version?.match(/^2\.(\d+)\.(\d+)$/);
  return !!match && Number(match[1]) >= 22;
};

export function planSettings(text: string) {
  const result = { commitStrategy: null as 'incremental' | 'incremental-at-end' | 'single-commit' | null,
    methodology: null as 'implementation-first' | 'tdd' | null, tddGranularity: null as 'task-based' | 'feature-based' | null };
  const clean = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  let fence = ''; let active = false; let sections = 0;
  const values: Record<string, string[]> = {};
  for (const line of clean.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = ''; continue; }
    if (fence) continue;
    if (/^## Settings\s*$/.test(line)) { active = true; sections++; continue; }
    if (/^#{1,2}\s/.test(line)) active = false;
    if (!active) continue;
    const setting = line.match(/^- (Commit strategy|Development methodology|TDD granularity):\s*([^#]*?)(?:\s+#.*)?$/);
    if (setting) (values[setting[1]] ??= []).push(setting[2].trim());
  }
  if (sections !== 1) return result;
  const one = (name: string, allowed: string[]) => values[name]?.length === 1 && allowed.includes(values[name][0]) ? values[name][0] : null;
  result.commitStrategy = one('Commit strategy', ['incremental', 'incremental-at-end', 'single-commit']) as typeof result.commitStrategy;
  result.methodology = one('Development methodology', ['implementation-first', 'tdd']) as typeof result.methodology;
  result.tddGranularity = result.methodology === 'tdd' ? one('TDD granularity', ['task-based', 'feature-based']) as typeof result.tddGranularity : null;
  return result;
}
