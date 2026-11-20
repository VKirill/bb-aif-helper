import path from 'node:path';

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
const DEPLOY_PREFIXES = ['выкатка', 'выкатить', 'отправить', 'deploy', 'publish', 'release', 'push'];
const FILES_END = /Depends on|Логи:|Logs:/;
const FILE_RANGE = /(\d+)\s*[-–]\s*(\d+)/g;
const FILE_SINGLE = /\d+/g;
const FILE_TOKEN = /`([^`]+)`/g;
const BAD_FILE = /[*?\s]/;

type DependsHint = { ids: number[]; ranges: [number, number][] } | 'none' | null;

function parseDependsOn(line: string): DependsHint {
  // The hint is the last occurrence: a task description may mention `Depends on` earlier.
  // AI Factory writes `(depends on 1, 2)` in the task line; hand-written plans use `Depends on: Task 3` below it.
  const all = [...line.matchAll(/depends on\s*:?\s*([^.;`\n]*)/gi)];
  const m = all[all.length - 1];
  if (!m) return null;
  const cap = m[1].trim();
  if (/^(none|нет)$/i.test(cap) || /^[—–-](?!\d)/.test(cap)) return 'none';
  // A range is kept as its two ends and expanded later against the plan's real task ids (resolveDependsOn).
  const ranges: [number, number][] = [];
  const ids: number[] = [];
  const rest = cap.replace(FILE_RANGE, (_all, a: string, b: string) => {
    ranges.push([Number(a), Number(b)]);
    ids.push(Number(a), Number(b));
    return ' ';
  });
  for (const s of rest.matchAll(FILE_SINGLE)) ids.push(Number(s[0]));
  return { ids, ranges };
}

function resolveDependsOn(hint: DependsHint, known: ReadonlySet<number>): PlanTask['dependsOn'] {
  if (hint === null || hint === 'none') return hint;
  const ids = new Set(hint.ids);
  for (const [a, b] of hint.ranges) {
    // Walks up only while the ids exist and stops at the first gap, which stays in the list and fails the
    // reference check: `1-999999999` costs no more than the plan is long, and `1-3` without task 2 is an error.
    const lo = Math.min(a, b), hi = Math.max(a, b);
    // Above 2^53 `id++` stops changing the number; parallelGroups rejects such ids anyway.
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) continue;
    for (let id = lo; id <= hi; id++) {
      ids.add(id);
      if (!known.has(id)) break;
    }
  }
  return [...ids].sort((x, y) => x - y);
}

function parseFiles(text: string): string[] | null {
  // The hint is the last `Files:` line: a task description may mention `Files:` earlier.
  const at = text.lastIndexOf('Files:');
  if (at === -1) return null;
  let sub = text.slice(at + 'Files:'.length).split('\n')[0];
  const end = sub.search(FILES_END);
  if (end !== -1) sub = sub.slice(0, end);
  // A note after a file (`(delete)`, `(секция \`name\`)`) is not a file.
  sub = sub.replace(/\([^()]*\)/g, ' ');
  const quoted = sub.includes('`');
  const tokens = quoted ? [...sub.matchAll(FILE_TOKEN)].map(m => m[1])
    : sub.split(',').map(t => t.trim().replace(/[.;]$/, '')).filter(Boolean);
  const files: string[] = [];
  for (const token of tokens) {
    if (BAD_FILE.test(token)) return null;
    // Without backticks a word is a file only if it looks like a path (`Files: перечисленные` is not a list).
    if (!quoted && !/[./\\]/.test(token)) return null;
    // A path outside the project (`/home/…`, `C:\\…`) is not in the worker's copy: the task runs alone.
    if (token.startsWith('/') || token.startsWith('\\') || /^[A-Za-z]:/.test(token) || token.startsWith('~')) return null;
    // One spelling per file: `SRC\\a.ts`, `src//a.ts` and `src/x/../a.ts` all name `src/a.ts`.
    let f = path.posix.normalize(token.replace(/\\/g, '/'));
    if (f === '..' || f.startsWith('../')) return null;
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
  const hints: DependsHint[] = [];
  let headings = 0;
  let prev = '';
  // A task is its line plus the indented lines under it (AI Factory puts `Files:` there); a heading, a line that is
  // not indented or the next task ends it.
  const bodies: string[] = [];
  let open = false;
  for (const line of scan) {
    if (!line.trim()) continue;
    const m = TASK_LINE.exec(line);
    if (m) {
      const title = m[3];
      const kind: PlanTaskKind = prev.trim() === COMMIT_MARKER ? 'commit'
        : DEPLOY_PREFIXES.some(p => title.toLowerCase().startsWith(p)) ? 'deploy' : 'code';
      tasks.push({ id: Number(m[2]), done: m[1].toLowerCase() === 'x', title, files: null, dependsOn: null,
        phase: Math.max(1, headings), order: tasks.length, kind });
      bodies.push(line);
      open = true;
    } else if (open && /^\s/.test(line)) {
      bodies[bodies.length - 1] += `\n${line}`;
    } else {
      open = false;
      if (line.trimStart().startsWith('### ')) headings++;
    }
    prev = line;
  }
  tasks.forEach((t, i) => {
    t.files = parseFiles(bodies[i] ?? '');
    hints.push(parseDependsOn(bodies[i] ?? ''));
  });
  const known = new Set(tasks.map(t => t.id));
  tasks.forEach((t, i) => { t.dependsOn = resolveDependsOn(hints[i], known); });
  return tasks;
}

/** Case-insensitive: on Windows and macOS `src/Foo.ts` and `SRC/foo.ts` are one file, so tasks touching them never run together. */
export function filesOverlap(a: string[], b: string[]): boolean {
  const lower = (list: string[]) => list.map(f => f.toLowerCase());
  const [la, lb] = [lower(a), lower(b)];
  return la.some(x => lb.some(y => x === y || x.startsWith(y + '/') || y.startsWith(x + '/')));
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

  const huge = tasks.flatMap(t => [t.id, ...(Array.isArray(t.dependsOn) ? t.dependsOn : [])]).find(id => !Number.isSafeInteger(id));
  if (huge !== undefined) return { error: `Слишком большой номер задачи: ${huge}.` };
  const byId = new Map(tasks.map(t => [t.id, t]));
  if (byId.size !== tasks.length) {
    const seen = new Set<number>();
    const twice = tasks.find(t => seen.size === seen.add(t.id).size)!;
    return { error: `Номер задачи ${twice.id} встречается дважды (например, Task ${twice.id} и Task 0${twice.id}).` };
  }
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
