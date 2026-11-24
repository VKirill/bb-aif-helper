import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as model from '../model.ts';

const EXPECTED_CONSTANTS = [
  'SCOUT_MODES',
  'SCOUT_DEPTHS',
  'SCOUT_ROLES',
  'SCOUT_CAPTURE',
  'SCOUT_STATUS',
  'SCOUT_CONFIDENCE',
  'SCOUT_ORIGIN',
  'SCOUT_FINDING_TYPES',
  'SCOUT_DECISION_IMPACT',
  'SCOUT_SEVERITY',
  'SCOUT_VERDICTS',
  'SCOUT_COVERAGE',
  'SCOUT_PROBLEM_CODES',
] as const;

const EVIDENCE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../skills/aif-scout/references/evidence.md',
);

test('evidence.md vocabulary section matches all 13 SCOUT_* constants in model.ts', () => {
  const content = readFileSync(EVIDENCE_PATH, 'utf8');
  const [, afterHeading] = content.split(/^## Словари\r?\n/m);
  assert.ok(afterHeading !== undefined, 'Missing "## Словари" section in evidence.md');
  const section = afterHeading.split(/\r?\n## /)[0];

  const parsed = new Map<string, string[]>();
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^- (SCOUT_[A-Z_]+): (.+)$/);
    if (!match) continue;
    const [, name, rawValues] = match;
    const values = Array.from(rawValues.matchAll(/`([^`]+)`/g), m => m[1]);
    assert.equal(parsed.has(name), false, `Duplicate constant in evidence.md: ${name}`);
    parsed.set(name, values);
  }

  assert.deepEqual([...parsed.keys()], [...EXPECTED_CONSTANTS]);
  for (const name of EXPECTED_CONSTANTS) {
    assert.deepEqual(parsed.get(name), [...model[name]], `Mismatch for ${name}`);
  }
});
