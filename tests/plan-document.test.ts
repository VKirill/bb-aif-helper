import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { savePlanDocument, markPlanVerified } from '../plan-document.ts';
import { planDigest, planVerification, withoutPlanVerification } from '../plan-verification.ts';
import { fixture } from './fixtures.ts';

const text = '# Plan\n\n## Tasks\n- [ ] 1. Fix input\n\n## Проверки\nOffline tests only.';
const hash = createHash('sha256').update(text).digest('hex');

test('verification is recorded only for completed unchanged plans and edits expire it without deleting the file', async () => {
  const f = await fixture(); try {
    const saved = await savePlanDocument({ root: f.root, threadId: 'thr_plan', seq: 20, hash, text });
    const filename = path.join(f.root, saved.path);
    let original = await fs.readFile(filename, 'utf8');
    await assert.rejects(markPlanVerified({ root: f.root, target: saved.path, expectedHash: planVerification(original).contentHash }), /невыполненные/);
    original = original.replace('- [ ]', '- [x]'); await fs.writeFile(filename, original, 'utf8');
    await assert.rejects(markPlanVerified({ root: f.root, target: saved.path, expectedHash: '0'.repeat(64) }), /изменился/);
    await assert.rejects(markPlanVerified({ root: f.root, target: '../outside.md', expectedHash: '0'.repeat(64) }));
    await markPlanVerified({ root: f.root, target: saved.path, expectedHash: planVerification(original).contentHash });
    const verified = await fs.readFile(filename, 'utf8');
    assert.equal(planVerification(verified).verified, true); assert.equal(withoutPlanVerification(verified), original);
    assert.equal(planVerification(verified.replace(/\n/g, '\r\n')).verified, true);
    assert.equal(planVerification(verified.replace('Fix input', 'Fix another input')).verified, false);
    assert.equal(planVerification('```\n<!-- bb-aif-plan-verified: sha256=' + planDigest(original) + ' -->\n```\n' + original).verified, false);
    assert.deepEqual(await savePlanDocument({ root: f.root, threadId: 'thr_plan', seq: 20, hash, text }), saved);
    assert.equal(await fs.readFile(filename, 'utf8'), verified);
  } finally { await f.cleanup(); }
});

test('completed plans are saved as Markdown under .bb and retries preserve owner edits', async () => {
  const f = await fixture(); try {
    const input = { root: f.root, threadId: 'thr_plan', seq: 20, hash, text };
    const saved = await savePlanDocument(input);
    assert(saved.path.startsWith('.bb/aif-helper/plans/')); assert(saved.path.endsWith('.md'));
    const filename = path.join(f.root, saved.path);
    const content = await fs.readFile(filename, 'utf8');
    assert(content.includes(text)); assert(!content.includes('proposed_plan'));
    await fs.writeFile(filename, content.replace('- [ ]', '- [x]'), 'utf8');
    assert.deepEqual(await savePlanDocument(input), saved);
    assert((await fs.readFile(filename, 'utf8')).includes('- [x]'));
    await fs.writeFile(filename, '# User document', 'utf8');
    await assert.rejects(savePlanDocument(input), /другим содержимым/);
    assert.equal(await fs.readFile(filename, 'utf8'), '# User document');
    await assert.rejects(fs.stat(path.join(f.root, '.bb-aif-helper')));
  } finally { await f.cleanup(); }
});

test('saving refuses path traversal, altered hashes and links outside the workspace', async () => {
  const f = await fixture(); const outside = await fixture();
  try {
    const input = { root: f.root, threadId: 'thr_plan', seq: 20, hash, text };
    await assert.rejects(savePlanDocument({ ...input, threadId: '../outside' }));
    await assert.rejects(savePlanDocument({ ...input, text: text + 'changed' }));
    await fs.symlink(outside.root, path.join(f.root, '.bb'), 'junction');
    await assert.rejects(savePlanDocument(input), /Ссылка/);
    await assert.rejects(fs.stat(path.join(outside.root, 'aif-helper')));
  } finally { await f.cleanup(); await outside.cleanup(); }
});
