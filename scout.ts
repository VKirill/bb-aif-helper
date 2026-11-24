import { parseDocument } from 'yaml';
import type { z } from 'zod';
import {
  SCOUT_CAPTURE,
  scoutCardSchema,
  scoutOpportunitiesSchema,
  scoutPlanSchema,
  type ScoutAngle,
  type ScoutCapture,
  type ScoutCard,
  type ScoutCheck,
  type ScoutCoverage,
  type ScoutFinding,
  type ScoutPlan,
  type ScoutProblem,
  type ScoutVerdict,
} from './model.ts';

export interface CheckScoutInput {
  plan: string;
  cards: { name: string; text: string }[];
  report?: string | null;
  opportunities?: string | null;
}

const CAPTURE_RANK: Record<ScoutCapture, number> = {
  full: 3,
  excerpt: 2,
  metadata_only: 1,
  unavailable: 0,
};

const READABLE = (capture: ScoutCapture): boolean => capture === 'full' || capture === 'excerpt';

const CONFIDENCE_RANK: Record<ScoutFinding['confidence'], number> = { low: 0, med: 1, high: 2 };

const EMPTY_COUNTS: ScoutCheck['counts'] = {
  sources: 0,
  full: 0,
  excerpt: 0,
  metadata_only: 0,
  unavailable: 0,
  findings: 0,
};

const SECTION_HEADINGS: readonly { key: 'established' | 'unknown' | 'nextStep'; label: string; names: readonly string[] }[] = [
  { key: 'established', label: 'Установлено', names: ['установлено', 'established'] },
  { key: 'unknown', label: 'Неизвестно', names: ['неизвестно', 'unknown'] },
  { key: 'nextStep', label: 'Следующий шаг', names: ['следующий шаг', 'next step'] },
];

interface ForbiddenRule {
  regex: RegExp;
  /** `cited` are the findings referenced on the same report line as the phrase. */
  allowed: (findings: ScoutFinding[], cited: ScoutFinding[]) => boolean;
  message: (phrase: string) => string;
}

const FORBIDDEN_RULES: readonly ForbiddenRule[] = [
  {
    regex: /(?<![\p{L}\p{N}_])(раст[её]т|растущ\p{L}*|growing|is growing|on the rise)(?![\p{L}\p{N}_])/iu,
    allowed: (_findings, cited) => new Set(cited.flatMap((f) => f.evidence.map((e) => e.source_date).filter(Boolean))).size >= 2,
    message: (phrase) => `Запрещённая фраза «${phrase}»: для оценки динамики пункт должен ссылаться на находки минимум с двумя разными source_date.`,
  },
  {
    regex: /(?<![\p{L}\p{N}_])(никто не (?:решает|делает|закрывает)|у конкурентов (?:нет|не)|ни у кого нет|nobody (?:solves|does|offers)|no one (?:solves|does|offers)|competitors (?:don't|do not|lack)|no competitor)(?![\p{L}\p{N}_])/iu,
    allowed: (findings) => findings.some((f) => f.type === 'competitor-capability'),
    message: (phrase) => `Запрещённая фраза «${phrase}»: нет находок с типом competitor-capability.`,
  },
  {
    regex: /(?<![\p{L}\p{N}_])(пользователи хотят|users want)(?![\p{L}\p{N}_])/iu,
    allowed: (findings) => findings.some((f) => f.type === 'wish' || f.type === 'pain'),
    message: (phrase) => `Запрещённая фраза «${phrase}»: нет находок с типом wish или pain.`,
  },
  {
    regex: /(?<![\p{L}\p{N}_])(основная боль|главная боль|main pain|the biggest pain)(?![\p{L}\p{N}_])/iu,
    allowed: (findings) => findings.some((f) => f.type === 'pain' && f.confidence !== 'low'),
    message: (phrase) => `Запрещённая фраза «${phrase}»: нет находок с типом pain и уверенностью выше low.`,
  },
];

function parseYamlSchema<T>(fileName: string, text: string, schema: z.ZodType<T>): { data: T | null; problem: ScoutProblem | null } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) {
    return {
      data: null,
      problem: { code: 'schema', severity: 'block', message: doc.errors[0].message, ref: fileName },
    };
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 20 });
  } catch (err) {
    return {
      data: null,
      problem: { code: 'schema', severity: 'block', message: err instanceof Error ? err.message : String(err), ref: fileName },
    };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      data: null,
      problem: { code: 'schema', severity: 'block', message: 'Корень YAML должен быть mapping.', ref: fileName },
    };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const issuePath = first.path.length ? first.path.join('.') : '(корень)';
    return {
      data: null,
      problem: { code: 'schema', severity: 'block', message: `${issuePath}: ${first.message}`, ref: fileName },
    };
  }
  return { data: parsed.data, problem: null };
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    }
    const serialized = u.toString();
    return u.pathname === '/' && !u.search ? serialized.replace(/\/$/, '') : serialized;
  } catch {
    return raw.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

function countSources(cards: ScoutCard[]): ScoutCheck['counts'] {
  const bestByUrl = new Map<string, ScoutCapture>();
  let findings = 0;

  for (const card of cards) {
    findings += card.findings.length;
    for (const item of [...card.findings, ...card.counter_evidence]) {
      for (const ev of item.evidence) {
        const url = normalizeUrl(ev.url);
        const prev = bestByUrl.get(url);
        if (!prev || CAPTURE_RANK[ev.capture] > CAPTURE_RANK[prev]) {
          bestByUrl.set(url, ev.capture);
        }
      }
    }
  }

  const countsByCapture: Record<ScoutCapture, number> = {
    full: 0,
    excerpt: 0,
    metadata_only: 0,
    unavailable: 0,
  };
  for (const capture of bestByUrl.values()) {
    countsByCapture[capture] += 1;
  }
  // Ensure every declared capture key is accounted for.
  for (const key of SCOUT_CAPTURE) {
    countsByCapture[key] = countsByCapture[key] ?? 0;
  }

  return {
    sources: bestByUrl.size,
    full: countsByCapture.full,
    excerpt: countsByCapture.excerpt,
    metadata_only: countsByCapture.metadata_only,
    unavailable: countsByCapture.unavailable,
    findings,
  };
}

function collectValidCards(
  plan: ScoutPlan,
  rawCards: { name: string; text: string }[],
  problems: ScoutProblem[],
): { name: string; card: ScoutCard }[] {
  const angleIds = new Set(plan.angles.map((a) => a.id));
  const valid: { name: string; card: ScoutCard }[] = [];

  for (const raw of rawCards) {
    const parsed = parseYamlSchema(raw.name, raw.text, scoutCardSchema);
    if (parsed.problem) {
      problems.push(parsed.problem);
      continue;
    }
    const card = parsed.data!;
    if (!angleIds.has(card.scout)) {
      problems.push({
        code: 'orphan_card',
        severity: 'block',
        message: `Карточка ссылается на неизвестный угол «${card.scout}».`,
        ref: raw.name,
      });
      continue;
    }
    valid.push({ name: raw.name, card });
  }
  return valid;
}

function indexIds(cards: ScoutCard[], problems: ScoutProblem[]): { findingById: Map<string, ScoutFinding>; knownIds: Set<string> } {
  const findingById = new Map<string, ScoutFinding>();
  const knownIds = new Set<string>();

  for (const card of cards) {
    for (const f of card.findings) {
      if (knownIds.has(f.id)) {
        problems.push({ code: 'duplicate_id', severity: 'block', message: `Повторяющийся идентификатор находки ${f.id}.`, ref: f.id });
      } else {
        knownIds.add(f.id);
        findingById.set(f.id, f);
      }
    }
    for (const ce of card.counter_evidence) {
      if (knownIds.has(ce.id)) {
        problems.push({ code: 'duplicate_id', severity: 'block', message: `Повторяющийся идентификатор находки ${ce.id}.`, ref: ce.id });
      } else {
        knownIds.add(ce.id);
      }
    }
  }
  return { findingById, knownIds };
}

function evaluateCoverage(
  plan: ScoutPlan,
  cardsByAngle: Map<string, ScoutCard[]>,
  problems: ScoutProblem[],
): ScoutCheck['coverage'] {
  const coverage: ScoutCheck['coverage'] = [];

  for (const angle of plan.angles) {
    const angleCards = cardsByAngle.get(angle.id) ?? [];
    const angleFindings = angleCards.flatMap((c) => c.findings);

    let state: ScoutCoverage;
    if (!angleFindings.length) {
      state = 'MISSING';
      problems.push({
        code: 'missing_required',
        severity: angle.required ? 'block' : 'gap',
        message: angle.required
          ? `Обязательный угол «${angle.id}» не имеет находок.`
          : `Необязательный угол «${angle.id}» не имеет находок.`,
        ref: angle.id,
      });
    } else if (angleFindings.some((f) => (f.status === 'VERIFIED' || f.status === 'REPORTED') && f.evidence.some((e) => READABLE(e.capture)))) {
      state = 'COVERED';
    } else {
      state = 'PARTIAL';
      problems.push({
        code: 'partial',
        severity: 'gap',
        message: `Угол «${angle.id}» покрыт только неполными или косвенными находками.`,
        ref: angle.id,
      });
    }

    coverage.push({ angle: angle.id, state });
  }

  return coverage;
}

function checkFindingQuality(
  validCards: { name: string; card: ScoutCard }[],
  angleById: Map<string, ScoutAngle>,
  allFindings: ScoutFinding[],
  problems: ScoutProblem[],
): void {
  const urlSpread = new Map<string, number>();

  for (const { name, card } of validCards) {
    if (!card.counter_evidence.length && !card.not_found.length) {
      const angle = angleById.get(card.scout);
      problems.push(
        angle?.mirror_of
          ? {
              code: 'counter_missing',
              severity: 'gap',
              message: `Зеркальный угол «${angle.id}» (карточка «${name}») не содержит counter_evidence и not_found.`,
              ref: angle.id,
            }
          : {
              code: 'counter_missing',
              severity: 'gap',
              message: `Карточка «${name}» угла «${card.scout}» не содержит counter_evidence и not_found.`,
              ref: name,
            },
      );
    }

    for (const f of card.findings) {
      for (const url of new Set(f.evidence.map((e) => normalizeUrl(e.url)))) {
        urlSpread.set(url, (urlSpread.get(url) ?? 0) + 1);
      }
    }

    // Counter-evidence is held to the same caps: it can override a finding in the synthesis.
    for (const f of [...card.findings, ...card.counter_evidence]) {
      const uniqueUrls = new Set(f.evidence.map((e) => normalizeUrl(e.url)));
      const readableUrls = new Set(f.evidence.filter((e) => READABLE(e.capture)).map((e) => normalizeUrl(e.url)));
      // Weakest-link cap from references/evidence.md: snippets or a single URL allow only low, high needs ≥ 3 read URLs.
      const cap: ScoutFinding['confidence'] =
        f.status === 'SNIPPET_ONLY' || !readableUrls.size || uniqueUrls.size <= 1
          ? 'low'
          : f.status === 'INFERRED' || readableUrls.size < 3
            ? 'med'
            : 'high';
      if (CONFIDENCE_RANK[f.confidence] > CONFIDENCE_RANK[cap]) {
        problems.push({
          code: 'confidence_cap',
          severity: 'gap',
          message: `Уверенность ${f.confidence} у ${f.id} выше допустимой ${cap} (источников ${uniqueUrls.size}, прочитано ${readableUrls.size}, статус ${f.status}).`,
          ref: f.id,
        });
      }
    }
  }

  if (allFindings.length >= 4) {
    const highCount = allFindings.filter((f) => f.confidence === 'high').length;
    if (highCount * 2 > allFindings.length) {
      problems.push({
        code: 'inflation',
        severity: 'gap',
        message: `Завышена доля находок с уверенностью high: ${highCount} из ${allFindings.length} (> 50%).`,
      });
    }
  }

  for (const [url, count] of urlSpread) {
    if (count > 3) {
      problems.push({
        code: 'single_source_spread',
        severity: 'gap',
        message: `Один источник опирает ${count} находок (> 3).`,
        ref: url,
      });
    }
  }
}

// A citation is a bracketed group of finding ids: (F101) or (F101, F102); a bare F1 is ordinary text.
const CITATION_RE = /[(\[]\s*(F\d+(?:\s*[,;]\s*F\d+)*)\s*[)\]]/g;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

type SectionKey = 'established' | 'unknown' | 'nextStep';
interface ReportBlock { text: string; item: boolean; section: SectionKey | null }

/** Split a report into headings, paragraph lines and list items (with their indented continuation lines). */
function reportBlocks(report: string, foundSections: Set<SectionKey>): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  let fence: { char: string; size: number } | null = null;
  let section: { key: SectionKey; level: number } | null = null;
  let item: ReportBlock | null = null;

  for (const line of report.split(/\r?\n/)) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1][0], size: open[1].length };
      item = null;
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      item = null;
      const level = heading[1].length;
      const matched = SECTION_HEADINGS.find((h) => h.names.includes(heading[2].trim().toLowerCase()));
      if (matched) {
        foundSections.add(matched.key);
        section = { key: matched.key, level };
      } else if (section && level <= section.level) {
        section = null;
      }
      blocks.push({ text: line, item: false, section: section?.key ?? null });
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      item = { text: line, item: true, section: section?.key ?? null };
      blocks.push(item);
    } else if (item && /^\s+\S/.test(line)) {
      item.text += `\n${line}`;
    } else if (line.trim()) {
      item = null;
      blocks.push({ text: line, item: false, section: section?.key ?? null });
    }
  }
  return blocks;
}

function checkReport(
  report: string,
  allFindings: ScoutFinding[],
  findingById: Map<string, ScoutFinding>,
  knownIds: Set<string>,
  problems: ScoutProblem[],
): void {
  const foundSections = new Set<SectionKey>();
  const reportedUnknownRefs = new Set<string>();
  const reportedPhrases = new Set<string>();

  for (const block of reportBlocks(report, foundSections)) {
    const stripped = block.text.replace(/https?:\/\/[^\s)>\]]+/g, '');
    const refs = [...stripped.matchAll(CITATION_RE)].flatMap((m) => m[1].split(/\s*[,;]\s*/));

    if (block.section === 'established' && block.item && !refs.length) {
      problems.push({
        code: 'unsupported_claim',
        severity: 'block',
        message: 'Пункт раздела «Установлено» не ссылается на находку (F<id>).',
        ref: block.text.trim().slice(0, 80),
      });
    }

    for (const refId of refs) {
      if (!knownIds.has(refId) && !reportedUnknownRefs.has(refId)) {
        reportedUnknownRefs.add(refId);
        problems.push({
          code: 'unknown_ref',
          severity: 'block',
          message: `Отчёт ссылается на неизвестную находку ${refId}.`,
          ref: refId,
        });
      }
    }

    // Open questions and next steps may name a trend without asserting it.
    if (block.section === 'unknown' || block.section === 'nextStep') continue;
    const cited = refs.flatMap((id) => findingById.get(id) ?? []);
    for (const rule of FORBIDDEN_RULES) {
      const match = rule.regex.exec(stripped);
      if (!match || reportedPhrases.has(match[0].toLowerCase()) || rule.allowed(allFindings, cited)) continue;
      reportedPhrases.add(match[0].toLowerCase());
      problems.push({
        code: 'forbidden_phrase',
        severity: 'block',
        message: rule.message(match[0]),
        ref: match[0],
      });
    }
  }

  for (const h of SECTION_HEADINGS) {
    if (!foundSections.has(h.key)) {
      problems.push({
        code: 'report_section',
        severity: 'block',
        message: `В отчёте отсутствует обязательный раздел «${h.label}».`,
        ref: h.label,
      });
    }
  }
}

function checkOpportunities(
  opportunitiesText: string | null | undefined,
  findingById: Map<string, ScoutFinding>,
  knownIds: Set<string>,
  problems: ScoutProblem[],
): void {
  if (!opportunitiesText || !opportunitiesText.trim()) {
    problems.push({
      code: 'no_opportunities',
      severity: 'gap',
      message: 'В режиме ideas не переданы карточки идей (opportunities).',
    });
    return;
  }

  const parsed = parseYamlSchema('opportunities.yaml', opportunitiesText, scoutOpportunitiesSchema);
  if (parsed.problem) {
    problems.push(parsed.problem);
    return;
  }

  const opportunities = parsed.data!.opportunities;
  if (!opportunities.length) {
    problems.push({
      code: 'no_opportunities',
      severity: 'gap',
      message: 'Список идей (opportunities) пуст.',
    });
    return;
  }

  const seenIds = new Set<string>();
  const reportedUnknownRefs = new Set<string>();

  for (const opp of opportunities) {
    if (seenIds.has(opp.id)) {
      problems.push({ code: 'duplicate_id', severity: 'block', message: `Повторяющийся идентификатор идеи ${opp.id}.`, ref: opp.id });
    } else {
      seenIds.add(opp.id);
    }

    if (!opp.why_existing_misses_it || !opp.evidence.length) {
      problems.push({
        code: 'opportunity_incomplete',
        severity: 'gap',
        message: `Идея ${opp.id} неполна: требуется why_existing_misses_it и хотя бы одна ссылка в evidence.`,
        ref: opp.id,
      });
    }

    const marketLangs = new Set<string>();
    for (const eid of opp.evidence) {
      const finding = findingById.get(eid);
      if (!finding) {
        if (!reportedUnknownRefs.has(eid)) {
          reportedUnknownRefs.add(eid);
          problems.push({
            code: 'unknown_ref',
            severity: 'block',
            message: `Идея ${opp.id} ссылается на неизвестную находку ${eid}.`,
            ref: eid,
          });
        }
        continue;
      }
      if (finding.market_lang) {
        marketLangs.add(finding.market_lang.trim().toLowerCase());
      }
    }

    for (const cid of opp.counterpoints) {
      if (knownIds.has(cid) || reportedUnknownRefs.has(cid)) continue;
      reportedUnknownRefs.add(cid);
      problems.push({ code: 'unknown_ref', severity: 'block', message: `Идея ${opp.id} ссылается на неизвестную находку ${cid} в counterpoints.`, ref: cid });
    }

    if (opp.market === 'both' && marketLangs.size < 2) {
      problems.push({
        code: 'market_both',
        severity: 'gap',
        message: `Идея ${opp.id} заявляет market: both, но находки не покрывают два разных market_lang.`,
        ref: opp.id,
      });
    }
  }
}

function verdictFromProblems(problems: ScoutProblem[]): ScoutVerdict {
  if (problems.some((p) => p.severity === 'block')) return 'NOT_READY';
  if (problems.some((p) => p.severity === 'gap')) return 'READY_WITH_GAPS';
  return 'READY';
}

/** Validate scout plan, cards, optional report and ideas opportunities without I/O. */
export function checkScout(input: CheckScoutInput): ScoutCheck {
  const parsedPlan = parseYamlSchema('plan.yaml', input.plan, scoutPlanSchema);
  if (parsedPlan.problem) {
    return {
      verdict: 'NOT_READY',
      mode: null,
      counts: { ...EMPTY_COUNTS },
      coverage: [],
      problems: [parsedPlan.problem],
    };
  }

  const plan = parsedPlan.data!;
  const problems: ScoutProblem[] = [];
  const validCards = collectValidCards(plan, input.cards, problems);
  const cards = validCards.map((c) => c.card);

  const angleById = new Map(plan.angles.map((a) => [a.id, a]));
  const cardsByAngle = new Map<string, ScoutCard[]>();
  for (const card of cards) {
    const list = cardsByAngle.get(card.scout);
    if (list) list.push(card);
    else cardsByAngle.set(card.scout, [card]);
  }

  const { findingById, knownIds } = indexIds(cards, problems);
  const allFindings = cards.flatMap((c) => c.findings);
  const counts = countSources(cards);
  const coverage = evaluateCoverage(plan, cardsByAngle, problems);

  checkFindingQuality(validCards, angleById, allFindings, problems);

  if (typeof input.report === 'string') {
    checkReport(input.report, allFindings, findingById, knownIds, problems);
  }

  if (plan.mode === 'ideas') {
    checkOpportunities(input.opportunities, findingById, knownIds, problems);
  }

  return {
    verdict: verdictFromProblems(problems),
    mode: plan.mode,
    counts,
    coverage,
    problems,
  };
}

/** Format a ScoutCheck result as a concise Russian summary. */
export function formatScoutCheck(result: ScoutCheck): string {
  const lines: string[] = [
    `Вердикт: ${result.verdict}${result.mode ? ` (${result.mode})` : ''}`,
    `источников ${result.counts.sources}: полностью ${result.counts.full}, фрагмент ${result.counts.excerpt}, метаданные ${result.counts.metadata_only}, недоступно ${result.counts.unavailable}; находок ${result.counts.findings}`,
  ];

  for (const item of result.coverage) {
    lines.push(`${item.angle}: ${item.state}`);
  }

  for (const problem of result.problems.slice(0, 20)) {
    lines.push(`- [${problem.severity}] ${problem.code}: ${problem.message}${problem.ref ? ` (${problem.ref})` : ''}`);
  }

  if (result.problems.length > 20) {
    lines.push(`… ещё ${result.problems.length - 20}`);
  }

  return lines.join('\n');
}
