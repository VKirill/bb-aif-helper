import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { requestSchema, runSchema, snapshotSchema, hostInputSchema, suggestionRequestSchema, suggestionActionSchema, suggestionsSchema, cardVisibilitySchema } from './model.ts';
export const hostContract = defineRpcContract({
  collect: { input: hostInputSchema, output: snapshotSchema, experimental_retryable: true },
  savePlan: { input: z.object({ root: z.string().min(1).max(4096), threadId: z.string().regex(/^[\w-]{1,200}$/),
    seq: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/), text: z.string().min(1).max(96000) }).strict(),
    output: z.object({ path: z.string() }), experimental_retryable: true },
  markPlanVerified: { input: z.object({ root: z.string().min(1).max(4096), target: z.string().min(1).max(1000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    output: z.object({ path: z.string(), verified: z.literal(true) }), experimental_retryable: false },
});
export const rpcContract = defineRpcContract({
  planDocument: { input: z.object({ threadId: z.string().min(1).max(200), text: z.string().min(1).max(96000) }).strict(),
    output: z.object({ path: z.string(), seq: z.number(), hash: z.string(), environmentId: z.string() }).nullable() },
  status: { input: requestSchema.extend({ checkUpdates: z.boolean().default(false), force: z.boolean().default(false) }), output: snapshotSchema },
  cardVisibility: { input: cardVisibilitySchema, output: z.object({ state: z.enum(['current', 'superseded', 'hidden']) }) },
  run: { input: runSchema, output: z.object({ sent: z.boolean(), message: z.string(), newTask: z.boolean().optional() }) },
  suggestions: { input: suggestionRequestSchema, output: suggestionsSchema },
  dismissSuggestion: { input: suggestionActionSchema, output: z.object({ dismissed: z.literal(true) }) },
  runSuggestion: { input: suggestionActionSchema.extend({ fingerprint: z.string().length(64), requestId: z.string().uuid() }), output: z.object({ sent: z.boolean(), message: z.string() }) },
});
