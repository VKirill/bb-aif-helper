// Parses `## Tasks` checklists from AI Factory plans and packs pending tasks
// into parallel groups: explicit and phase-implied dependencies, file overlap
// and solo tasks (commit/deploy markers, unclear file sets) decide the packing.
export type PlanTaskKind = 'code' | 'commit' | 'deploy';

export type PlanTask = {
  id: number;
  done: boolean;
  title: string;
  files: string[] | null;
  dependsOn: number[] | 'none' | null;
  phase: number;
  order: number;
  kind: PlanTaskKind;
};

const TASK_LINE = /^\s*- \[([ xX])\] Task (\d+):\s*(.*)$/;
const COMMIT_MARKER = '<!-- aif:task-kind:commit -->';
const DEPLOY_PREFIXES = ['выкатка', 'deploy', 'publish', 'release', 'push'];
const FILES_END = /Depends on|Логи:|Logs:/;
const FILE_RANGE = /(\d+)\s*[-–]\s*(\d+)/g;
const FILE_SINGLE = /\d+/g;
const FILE_TOKEN = /`([^`]+)`/g;
const BAD_FILE = /[*?\s]/;

function parseDependsOn(line: string): number[] | 'none' | null {
  // The hint is the last occurrence: a task description may mention `Depends on` earlier.
  const all = [...line.matchAll(/Depends on\s+([^.;`]*)/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  const cap = m[1].trim();
  if (/^(none|нет)$/i.test(cap) || /^[—–-](?!\d)/.test(cap)) return 'none';
  const ids = new Set<number>();
  const rest = cap.replace(FILE_RANGE, (_all, a: string, b: string) => {
    for (let i = Number(a); i <= Number(b); i++) ids.add(i);
    return ' ';
  });
  for (const s of rest.matchAll(FILE_SINGLE)) ids.add(Number(s[0]));
  return [...ids].sort((x, y) => x - y);
}

function parseFiles(line: string): string[] | null {
  // The hint is the last occurrence: a task description may mention `Files:` earlier.
  const at = line.lastIndexOf('Files:');
  if (at === -1) return null;
  let sub = line.slice(at + 'Files:'.length);
  const end = sub.search(FILES_END);
  if (end !== -1) sub = sub.slice(0, end);
  const files: string[] = [];
  for (const m of sub.matchAll(FILE_TOKEN)) {
    const token = m[1];
    if (BAD_FILE.test(token)) return null;
    let f = token;
    if (f.startsWith('./')) f = f.slice(2);
    if (f.endsWith('/')) f = f.slice(0, -1);
    files.push(f);
  }
  return files.length ? files : null;
}

export function parsePlanTasks(text: string): PlanTask[] {
  const lines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (start === -1) {
      if (t === '## Tasks') start = i;
    } else if (t.startsWith('## ')) {
      end = i;
      break;
    }
  }
  const scan = start === -1 ? lines : lines.slice(start, end);
  const tasks: PlanTask[] = [];
  let headings = 0;
  let prev = '';
  for (const line of scan) {
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('### ')) {
      headings++;
    } else {
      const m = TASK_LINE.exec(line);
      if (m) {
        const title = m[3];
        const kind: PlanTaskKind = prev.trim() === COMMIT_MARKER ? 'commit'
          : DEPLOY_PREFIXES.some(p => title.toLowerCase().startsWith(p)) ? 'deploy' : 'code';
        tasks.push({
          id: Number(m[2]),
          done: m[1].toLowerCase() === 'x',
          title,
          files: parseFiles(line),
          dependsOn: parseDependsOn(line),
          phase: Math.max(1, headings),
          order: tasks.length,
          kind,
        });
      }
    }
    prev = line;
  }
  return tasks;
}

export function filesOverlap(a: string[], b: string[]): boolean {
  return a.some(x => b.some(y => x === y || x.startsWith(y + '/') || y.startsWith(x + '/')));
}

export type ParallelGroups = { groups: number[][]; coordinatorOnly: number[] } | { error: string };

export function parallelGroups(text: string, max: number): ParallelGroups {
  if (text.includes('<!-- aif:plan-mode:ultra -->')) {
    return { error: 'Ultra-планы не поддерживаются: выполняйте задачи последовательно.' };
  }
  const tasks = parsePlanTasks(text);
  if (!tasks.length) return { error: 'В плане нет задач.' };
  let limit = Math.trunc(max);
  if (!Number.isFinite(limit)) limit = 1;
  limit = Math.min(4, Math.max(1, limit));

  const byId = new Map(tasks.map(t => [t.id, t]));
  for (const t of tasks) {
    if (!Array.isArray(t.dependsOn)) continue;
    for (const d of t.dependsOn) {
      if (!byId.has(d)) return { error: `Задача ${t.id} зависит от несуществующей задачи ${d}.` };
    }
  }
  const depsOf = new Map<number, number[]>();
  for (const t of tasks) {
    depsOf.set(t.id, Array.isArray(t.dependsOn) ? t.dependsOn
      : t.dependsOn === 'none' ? []
      : tasks.filter(o => o.phase < t.phase).map(o => o.id));
  }

  let pending = tasks.filter(t => !t.done).sort((a, b) => a.order - b.order);
  const groups: number[][] = [];
  const scheduled = new Set<number>();
  while (pending.length) {
    const group: PlanTask[] = [];
    for (const t of pending) {
      const ready = depsOf.get(t.id)!.every(d => byId.get(d)!.done || scheduled.has(d));
      if (!ready) continue;
      if (t.kind !== 'code' || t.files === null) {
        if (group.length === 0) {
          group.push(t);
          break;
        }
        continue;
      }
      const files = t.files;
      if (group.length >= limit || group.some(m => filesOverlap(files, m.files!))) continue;
      group.push(t);
    }
    if (!group.length) {
      return { error: `Цикл в зависимостях задач: ${pending.map(t => t.id).join(', ')}.` };
    }
    const placed = new Set(group);
    for (const t of group) scheduled.add(t.id);
    pending = pending.filter(t => !placed.has(t));
    groups.push(group.map(t => t.id));
  }
  const coordinatorOnly = tasks.filter(t => !t.done && t.kind !== 'code').map(t => t.id);
  return { groups, coordinatorOnly };
}
