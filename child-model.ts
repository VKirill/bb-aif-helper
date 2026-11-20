// Domain module: type-only imports, so it stays free of the node:fs data-access code in delegation.ts.
import type { DelegationChoice, DelegationState, ResearchRole } from './delegation.ts';

const SLOTS = ['research', 'research2', 'research3'] as const satisfies readonly ResearchRole[];

type ModelEvent = { seq: number; type: string; data: unknown };
export type ChildModel = { execution: { model: string; reasoning: string | null } | null; fallback: { from: string; to: string; reason: string } | null; mismatch: string | null };
/**
 * The model BB requested for a child thread's latest turn (client/turn/requested), a provider fallback after it
 * (provider/modelFallback, only Claude Code reports one) and a mismatch with the owner's choice for AIF worker titles.
 */
export function childModel(rows: readonly ModelEvent[], child: { title: string | null; providerId: string | null }, state: Pick<DelegationState, 'choice' | ResearchRole>): ChildModel {
  const sorted = [...rows].sort((a, b) => b.seq - a.seq);
  const request = sorted.find(r => r.type === 'client/turn/requested');
  const ex = (request?.data as { execution?: { model?: unknown; reasoningLevel?: unknown } } | undefined)?.execution;
  const execution = typeof ex?.model === 'string' ? { model: ex.model, reasoning: typeof ex.reasoningLevel === 'string' ? ex.reasoningLevel : null } : null;
  const fb = sorted.find(r => r.type === 'provider/modelFallback' && (!request || r.seq > request.seq))?.data as { originalModel?: unknown; fallbackModel?: unknown; reason?: unknown } | undefined;
  const fallback = fb && typeof fb.originalModel === 'string' && typeof fb.fallbackModel === 'string' ? { from: fb.originalModel, to: fb.fallbackModel, reason: String(fb.reason ?? '') } : null;
  const title = child.title ?? '';
  const slots = title.startsWith('AIF research · ') ? SLOTS.map(r => state[r].mode === 'self' ? state.research : state[r])
    : title.startsWith('AIF · ') ? [state.choice] : [];
  const allowed = slots.filter((c): c is Extract<DelegationChoice, { mode: 'bb' }> => c.mode === 'bb');
  const ok = !execution || !allowed.length || allowed.some(c => c.model === execution.model && (!child.providerId || c.providerId === child.providerId));
  return { execution, fallback, mismatch: ok ? null : `Ожидалась модель ${[...new Set(allowed.map(c => `${c.providerId} · ${c.model}`))].join(' или ')}` };
}
