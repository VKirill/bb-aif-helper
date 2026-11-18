import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BASIC_PLAN_ROOT, BASIC_PLAN_ROOTS } from './basic-workflow.ts';
import { safeRelative, taskList } from './reader.ts';
import { planDigest, planVerification, withoutPlanVerification } from './plan-verification.ts';

export async function savePlanDocument(input: { root: string; threadId: string; seq: number; hash: string; text: string }) {
  if (!/^[\w-]{1,200}$/.test(input.threadId) || !Number.isSafeInteger(input.seq) || input.seq < 0
    || !/^[a-f0-9]{64}$/.test(input.hash) || Buffer.byteLength(input.text) > 96000
    || createHash('sha256').update(input.text).digest('hex') !== input.hash) throw new Error('Некорректный документ плана.');
  const root = await fs.realpath(input.root);
  let directory = root;
  for (const segment of BASIC_PLAN_ROOT.split('/')) {
    directory = path.join(directory, segment);
    try { await fs.mkdir(directory); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Ссылка или файл в пути сохранения плана.');
  }
  const rel = `${BASIC_PLAN_ROOT}/plan-${input.threadId}-${input.seq}-${input.hash.slice(0, 16)}.md`;
  const filename = path.join(root, rel);
  const marker = `<!-- bb-aif-plan: ${input.hash} source-seq=${input.seq} -->`;
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, 'wx');
  try {
    try { await handle.writeFile(`${marker}\n\n${input.text}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporary, filename); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Небезопасный существующий файл плана.');
      const existing = await fs.readFile(filename, 'utf8');
      const original = withoutPlanVerification(existing);
      if (!original.startsWith(marker + '\n') && !original.startsWith(marker + '\r\n')) throw new Error('Файл плана уже существует с другим содержимым.');
      // The owner may have checked off tasks since generation. Never overwrite it.
    }
  } finally { await fs.unlink(temporary); }
  return { path: rel };
}

/** Records the verification owner's declaration; it does not run checks. */
export async function markPlanVerified(input: { root: string; target: string; expectedHash: string }) {
  const rel = safeRelative(input.target);
  if (!BASIC_PLAN_ROOTS.some(base => rel.startsWith(base + '/') && !rel.slice(base.length + 1).includes('/') && rel.endsWith('.md')))
    throw new Error('Отметка разрешена только для базового файла плана.');
  const root = await fs.realpath(input.root);
  let filename = root;
  for (const part of rel.split('/')) {
    filename = path.join(filename, part);
    if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error('Ссылка или junction в пути плана.');
  }
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Недопустимый файл плана.');
  const text = await fs.readFile(filename, 'utf8');
  const state = planVerification(text);
  if (state.contentHash !== input.expectedHash) throw new Error('План изменился после проверки. Перечитайте его.');
  const tasks = taskList(text);
  if (!tasks.length || tasks.some(task => !task.done)) throw new Error('В плане остались невыполненные пункты.');
  if (state.verified) return { path: rel, verified: true as const };
  const body = withoutPlanVerification(text);
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const updated = `<!-- bb-aif-plan-verified: sha256=${planDigest(body)} -->${eol}${body}`;
  const temporary = `${filename}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, updated, { encoding: 'utf8', flag: 'wx' });
    if (planVerification(await fs.readFile(filename, 'utf8')).contentHash !== input.expectedHash) throw new Error('План изменился во время записи отметки.');
    await fs.rename(temporary, filename);
  } finally { try { await fs.unlink(temporary); } catch (error: any) { if (error.code !== 'ENOENT') throw error; } }
  return { path: rel, verified: true as const };
}
