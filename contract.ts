import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { delegationChoiceSchema, delegationRoleSchema, delegationStateSchema } from './delegation.ts';
import { requestSchema, runSchema, snapshotSchema, hostInputSchema, suggestionRequestSchema, suggestionActionSchema, suggestionsSchema, gateResultSchema } from './model.ts';
import { SKIPPABLE_STEPS } from './readiness.ts';
export const delegationViewSchema = delegationStateSchema.extend({
  providers: z.array(z.object({ id: z.string(), name: z.string() })),
  children: z.array(z.object({ id: z.string(), title: z.string().nullable(), status: z.string(), providerId: z.string().nullable(), updatedAt: z.string() })),
});
export type DelegationView = z.infer<typeof delegationViewSchema>;
export const hostContract = defineRpcContract({
  collect: { input: hostInputSchema, output: snapshotSchema, experimental_retryable: true },
  delegation: { input: z.object({ root: z.string().min(1).max(4096) }).strict(), output: delegationStateSchema, experimental_retryable: true },
  setDelegation: { input: z.object({ root: z.string().min(1).max(4096), choice: delegationChoiceSchema, role: delegationRoleSchema.optional() }).strict(), output: delegationStateSchema },
});
export const rpcContract = defineRpcContract({
  status: { input: requestSchema.extend({ checkUpdates: z.boolean().default(false), force: z.boolean().default(false) }), output: snapshotSchema },
  run: { input: runSchema, output: z.object({ sent: z.boolean(), stale: z.boolean().optional(), message: z.string() }) },
  suggestions: { input: suggestionRequestSchema, output: suggestionsSchema },
  dismissSuggestion: { input: suggestionActionSchema, output: z.object({ dismissed: z.literal(true) }) },
  delegation: { input: z.object({ threadId: z.string().min(1).max(200) }).strict(), output: delegationViewSchema },
  setDelegation: { input: z.object({ threadId: z.string().min(1).max(200), choice: delegationChoiceSchema, role: delegationRoleSchema.optional() }).strict(), output: delegationViewSchema },
  setReadinessSkip: { input: z.object({ threadId: z.string().min(1).max(200), stepId: z.enum(SKIPPABLE_STEPS), skipped: z.boolean() }).strict(), output: z.object({ ok: z.literal(true) }) },
  runSuggestion: { input: suggestionActionSchema.extend({ fingerprint: z.string().length(64), requestId: z.string().uuid() }), output: z.object({ sent: z.boolean(), stale: z.boolean().optional(), message: z.string(),
    command: z.string().optional(),
    data: z.object({ source: z.literal('aif-chat'), sourceKey: z.string(), commandId: z.string(), fingerprint: z.string(), gate: gateResultSchema.nullable() }).optional() }) },
});
