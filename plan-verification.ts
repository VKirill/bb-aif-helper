import { createHash } from 'node:crypto';

const leading = /^<!-- bb-aif-plan-verified:[^\r\n]*-->\r?\n/;
export const withoutPlanVerification = (text: string) => text.replace(leading, '');
export const planDigest = (text: string) => createHash('sha256').update(withoutPlanVerification(text).replace(/\r\n/g, '\n').trimEnd() + '\n').digest('hex');
export function planVerification(text: string) {
  const marker = text.match(/^<!-- bb-aif-plan-verified: sha256=([a-f0-9]{64}) -->\r?\n/);
  return { contentHash: createHash('sha256').update(text).digest('hex'), verified: !!marker && marker[1] === planDigest(text) };
}
