import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScout, formatScoutCheck } from '../scout.ts';

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/scout');

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

const devPlan = readFixture('dev-plan.yaml');
const devCardDocs = readFixture('dev-card-docs.yaml');
const devCardTracker = readFixture('dev-card-tracker.yaml');
const reportOk = readFixture('report-ok.md');
const ideasPlan = readFixture('ideas-plan.yaml');
const ideasCardPains = readFixture('ideas-card-pains.yaml');
const ideasOpportunities = readFixture('ideas-opportunities.yaml');

test('1. valid dev plan + cards + report -> READY, distinct URL counts by best capture, all angles COVERED', () => {
  const result = checkScout({
    plan: devPlan,
    cards: [
      { name: 'dev-card-docs.yaml', text: devCardDocs },
      { name: 'dev-card-tracker.yaml', text: devCardTracker },
    ],
    report: reportOk,
  });

  assert.equal(result.verdict, 'READY');
  assert.equal(result.mode, 'dev');
  assert.deepEqual(result.counts, {
    sources: 6,
    full: 2,
    excerpt: 2,
    metadata_only: 1,
    unavailable: 1,
    findings: 4,
  });
  assert.deepEqual(result.coverage, [
    { angle: 'dev-docs', state: 'COVERED' },
    { angle: 'dev-tracker', state: 'COVERED' },
  ]);
  assert.deepEqual(result.problems, []);
});

test('2. card with only SNIPPET_ONLY/metadata_only findings -> READY_WITH_GAPS, PARTIAL coverage, partial problem', () => {
  const snippetOnlyTracker = devCardTracker
    .replace('capture: full', 'capture: metadata_only')
    .replace('status: VERIFIED', 'status: SNIPPET_ONLY');

  const result = checkScout({
    plan: devPlan,
    cards: [
      { name: 'dev-card-docs.yaml', text: devCardDocs },
      { name: 'dev-card-tracker.yaml', text: snippetOnlyTracker },
    ],
  });

  assert.equal(result.verdict, 'READY_WITH_GAPS');
  assert.deepEqual(result.coverage, [
    { angle: 'dev-docs', state: 'COVERED' },
    { angle: 'dev-tracker', state: 'PARTIAL' },
  ]);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].code, 'partial');
  assert.equal(result.problems[0].severity, 'gap');
  assert.equal(result.problems[0].ref, 'dev-tracker');
});

test('3. missing required angle -> NOT_READY block; missing non-required angle -> gap only', () => {
  const missingRequired = checkScout({
    plan: devPlan,
    cards: [{ name: 'dev-card-docs.yaml', text: devCardDocs }],
  });

  assert.equal(missingRequired.verdict, 'NOT_READY');
  assert.deepEqual(missingRequired.coverage, [
    { angle: 'dev-docs', state: 'COVERED' },
    { angle: 'dev-tracker', state: 'MISSING' },
  ]);
  assert.ok(
    missingRequired.problems.some(
      (p) => p.code === 'missing_required' && p.severity === 'block' && p.ref === 'dev-tracker',
    ),
  );

  const planWithOptional =
    devPlan +
    `\n  - id: dev-science\n    role: measurement\n    hypothesis: "Бенчмарки показывают накладные расходы буферизации"\n    required: false\n`;

  const missingOptional = checkScout({
    plan: planWithOptional,
    cards: [
      { name: 'dev-card-docs.yaml', text: devCardDocs },
      { name: 'dev-card-tracker.yaml', text: devCardTracker },
    ],
  });

  assert.equal(missingOptional.verdict, 'READY_WITH_GAPS');
  assert.deepEqual(missingOptional.coverage, [
    { angle: 'dev-docs', state: 'COVERED' },
    { angle: 'dev-tracker', state: 'COVERED' },
    { angle: 'dev-science', state: 'MISSING' },
  ]);
  assert.deepEqual(
    missingOptional.problems.map((p) => ({ code: p.code, severity: p.severity, ref: p.ref })),
    [{ code: 'missing_required', severity: 'gap', ref: 'dev-science' }],
  );
});

test('4. card whose scout is not a plan angle -> orphan_card, excluded from counts', () => {
  const singleAnglePlan = devPlan.split('\n  - id: dev-tracker')[0] + '\n';
  const orphanCard = devCardTracker.replace('scout: dev-tracker', 'scout: unknown-angle');

  const result = checkScout({
    plan: singleAnglePlan,
    cards: [
      { name: 'dev-card-docs.yaml', text: devCardDocs },
      { name: 'orphan.yaml', text: orphanCard },
    ],
  });

  assert.equal(result.verdict, 'NOT_READY');
  assert.ok(
    result.problems.some(
      (p) => p.code === 'orphan_card' && p.severity === 'block' && p.ref === 'orphan.yaml',
    ),
  );
  assert.deepEqual(result.counts, {
    sources: 4,
    full: 1,
    excerpt: 2,
    metadata_only: 0,
    unavailable: 1,
    findings: 2,
  });
});

test('5. confidence high with one URL -> confidence_cap', () => {
  const singleUrlHighCard = devCardTracker
    .replace('capture: metadata_only\n        source_date: 2026-09-02', 'capture: full\n        source_date: 2026-09-02')
    .replace('status: REPORTED\n    confidence: low', 'status: VERIFIED\n    confidence: high');

  const result = checkScout({
    plan: devPlan,
    cards: [
      { name: 'dev-card-docs.yaml', text: devCardDocs },
      { name: 'dev-card-tracker.yaml', text: singleUrlHighCard },
    ],
  });

  assert.equal(result.verdict, 'READY_WITH_GAPS');
  assert.ok(
    result.problems.some((p) => p.code === 'confidence_cap' && p.severity === 'gap' && p.ref === 'F4'),
  );
});

test('6. report with "растёт" and one as_of -> forbidden_phrase block; two as_of dates -> allowed', () => {
  const reportWithGrowth = reportOk.replace(
    '## Следующий шаг',
    '- Частота сбоев растёт от релиза к релизу (F4).\n\n## Следующий шаг',
  );

  const blocked = checkScout({
    plan: devPlan,
    cards: [
      { name: 'dev-card-docs.yaml', text: devCardDocs },
      { name: 'dev-card-tracker.yaml', text: devCardTracker },
    ],
    report: reportWithGrowth,
  });

  assert.equal(blocked.verdict, 'NOT_READY');
  assert.ok(
    blocked.problems.some((p) => p.code === 'forbidden_phrase' && p.severity === 'block'),
  );

  const secondDateTracker = devCardTracker.replace('as_of: 2026-11-24', 'as_of: 2026-10-01');
  const allowed = checkScout({
    plan: devPlan,
    cards: [
      { name: 'dev-card-docs.yaml', text: devCardDocs },
      { name: 'dev-card-tracker.yaml', text: secondDateTracker },
    ],
    report: reportWithGrowth,
  });

  assert.equal(allowed.verdict, 'READY');
  assert.equal(allowed.problems.some((p) => p.code === 'forbidden_phrase'), false);
});

test('7. report validation: unsupported_claim, unknown_ref F999, and missing section Неизвестно', () => {
  const cards = [
    { name: 'dev-card-docs.yaml', text: devCardDocs },
    { name: 'dev-card-tracker.yaml', text: devCardTracker },
  ];

  const unsupported = checkScout({
    plan: devPlan,
    cards,
    report: reportOk.replace('## Неизвестно', '- Утверждение без ссылки на корпус.\n\n## Неизвестно'),
  });
  assert.equal(unsupported.verdict, 'NOT_READY');
  assert.ok(unsupported.problems.some((p) => p.code === 'unsupported_claim' && p.severity === 'block'));

  const unknownRef = checkScout({
    plan: devPlan,
    cards,
    report: reportOk.replace('(F1)', '(F1, F999)'),
  });
  assert.equal(unknownRef.verdict, 'NOT_READY');
  assert.ok(unknownRef.problems.some((p) => p.code === 'unknown_ref' && p.severity === 'block' && p.ref === 'F999'));

  const missingSection = checkScout({
    plan: devPlan,
    cards,
    report: reportOk.replace(/## Неизвестно[\s\S]*?(?=## Следующий шаг)/, ''),
  });
  assert.equal(missingSection.verdict, 'NOT_READY');
  assert.ok(
    missingSection.problems.some(
      (p) => p.code === 'report_section' && p.severity === 'block' && p.ref === 'Неизвестно',
    ),
  );
});

test('8. duplicate YAML key in card -> schema + NOT_READY; invalid plan -> NOT_READY and mode null', () => {
  const duplicateKeyCard = devCardDocs + '\nqueries_run: 99\n';
  const badCardResult = checkScout({
    plan: devPlan,
    cards: [
      { name: 'dev-card-docs.yaml', text: duplicateKeyCard },
      { name: 'dev-card-tracker.yaml', text: devCardTracker },
    ],
  });

  assert.equal(badCardResult.verdict, 'NOT_READY');
  assert.ok(
    badCardResult.problems.some(
      (p) => p.code === 'schema' && p.severity === 'block' && p.ref === 'dev-card-docs.yaml',
    ),
  );

  const badPlanResult = checkScout({
    plan: devPlan.replace('mode: dev', 'mode: invalid'),
    cards: [{ name: 'dev-card-docs.yaml', text: devCardDocs }],
  });

  assert.equal(badPlanResult.verdict, 'NOT_READY');
  assert.equal(badPlanResult.mode, null);
  assert.deepEqual(badPlanResult.counts, {
    sources: 0,
    full: 0,
    excerpt: 0,
    metadata_only: 0,
    unavailable: 0,
    findings: 0,
  });
  assert.deepEqual(badPlanResult.coverage, []);
  assert.ok(badPlanResult.problems.some((p) => p.code === 'schema' && p.severity === 'block'));
});

test('9. duplicate finding id across two cards -> duplicate_id', () => {
  const duplicateIdTracker = devCardTracker.replace('id: F4', 'id: F1');

  const result = checkScout({
    plan: devPlan,
    cards: [
      { name: 'dev-card-docs.yaml', text: devCardDocs },
      { name: 'dev-card-tracker.yaml', text: duplicateIdTracker },
    ],
  });

  assert.equal(result.verdict, 'NOT_READY');
  assert.ok(
    result.problems.some((p) => p.code === 'duplicate_id' && p.severity === 'block' && p.ref === 'F1'),
  );
});

test('10. ideas mode: no_opportunities, opportunity_incomplete, market_both, and valid ideas set', () => {
  const noOpps = checkScout({
    plan: ideasPlan,
    cards: [{ name: 'ideas-card-pains.yaml', text: ideasCardPains }],
  });
  assert.equal(noOpps.verdict, 'READY_WITH_GAPS');
  assert.ok(noOpps.problems.some((p) => p.code === 'no_opportunities' && p.severity === 'gap'));

  const incompleteOpps = checkScout({
    plan: ideasPlan,
    cards: [{ name: 'ideas-card-pains.yaml', text: ideasCardPains }],
    opportunities: ideasOpportunities.replace(/^\s*why_existing_misses_it:.*\n/m, ''),
  });
  assert.equal(incompleteOpps.verdict, 'READY_WITH_GAPS');
  assert.ok(
    incompleteOpps.problems.some(
      (p) => p.code === 'opportunity_incomplete' && p.severity === 'gap' && p.ref === 'O1',
    ),
  );

  const singleMarketCard = ideasCardPains.replace('market_lang: ru', 'market_lang: en');
  const marketBothMismatch = checkScout({
    plan: ideasPlan,
    cards: [{ name: 'ideas-card-pains.yaml', text: singleMarketCard }],
    opportunities: ideasOpportunities,
  });
  assert.equal(marketBothMismatch.verdict, 'READY_WITH_GAPS');
  assert.ok(
    marketBothMismatch.problems.some(
      (p) => p.code === 'market_both' && p.severity === 'gap' && p.ref === 'O1',
    ),
  );

  const validIdeas = checkScout({
    plan: ideasPlan,
    cards: [{ name: 'ideas-card-pains.yaml', text: ideasCardPains }],
    opportunities: ideasOpportunities,
  });
  assert.equal(validIdeas.verdict, 'READY');
  assert.equal(validIdeas.mode, 'ideas');
  assert.deepEqual(validIdeas.problems, []);
});

test('11. formatScoutCheck prints verdict, counts line, and caps problems at 20 with "… ещё"', () => {
  const extraClaims = Array.from({ length: 22 }, (_, i) => `- Утверждение без ссылки ${i + 1}.`).join('\n');
  const manyProblemsReport = reportOk.replace('## Неизвестно', `${extraClaims}\n\n## Неизвестно`);

  const result = checkScout({
    plan: devPlan,
    cards: [
      { name: 'dev-card-docs.yaml', text: devCardDocs },
      { name: 'dev-card-tracker.yaml', text: devCardTracker },
    ],
    report: manyProblemsReport,
  });

  assert.equal(result.problems.length, 22);
  const formatted = formatScoutCheck(result);
  const lines = formatted.split('\n');

  assert.equal(lines[0], 'Вердикт: NOT_READY (dev)');
  assert.equal(
    lines[1],
    'источников 6: полностью 2, фрагмент 2, метаданные 1, недоступно 1; находок 4',
  );
  assert.equal(lines.filter((line) => line.startsWith('- [')).length, 20);
  assert.equal(lines.at(-1), '… ещё 2');
});

test('12. ideas mode: unknown finding id in counterpoints → unknown_ref', () => {
  const result = checkScout({
    plan: ideasPlan,
    cards: [{ name: 'ideas-card-pains.yaml', text: ideasCardPains }],
    opportunities: ideasOpportunities.replace(/^(\s*)counterpoints:.*$/m, '$1counterpoints: [F777]'),
  });
  assert.equal(result.verdict, 'NOT_READY');
  assert.ok(result.problems.some((p) => p.code === 'unknown_ref' && p.ref === 'F777'));
});
