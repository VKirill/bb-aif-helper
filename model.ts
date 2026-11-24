import { z } from 'zod';

export const phaseSchema = z.enum(['unknown', 'explore', 'plan', 'improve', 'implement', 'verify', 'fix', 'done']);
export const requestSchema = z.object({
  threadId: z.string().min(1).max(200),
  target: z.string().max(1000).default(''),
  phase: phaseSchema.default('unknown'),
  newTask: z.boolean().optional(),
}).strict();
export const actionSchema = z.object({
  id: z.string(), label: z.string(), command: z.string(), group: z.enum(['next', 'check', 'setup', 'maintenance']),
  reason: z.string(), available: z.boolean(), disabledReason: z.enum(['unchanged', 'requires-cli222', 'context-blocked']).optional(),
});
export const readinessStepSchema = z.object({
  id: z.string(), label: z.string(), actionId: z.string(),
  state: z.enum(['done', 'todo', 'skipped']), skippable: z.boolean(), anyOf: z.boolean(),
  missing: z.array(z.string()),
});
export const snapshotSchema = z.object({
  schemaVersion: z.literal('aif-chat/v1'), collectedAt: z.string(), fingerprint: z.string(),
  inputsFingerprint: z.string().length(64).nullable().default(null),
  versionsCheckedAt: z.string().optional(),
  cache: z.object({ source: z.enum(['live', 'memory', 'saved']), refreshing: z.boolean(), refreshError: z.boolean() }).optional(),
  root: z.string(), runtime: z.string(), configured: z.boolean(),
  worktree: z.object({ hasUncommitted: z.boolean().nullable() }).default({ hasUncommitted: null }),
  profile: z.enum(['none', 'upstream', 'aifhub-classic', 'aifhub-openspec', 'aifhub-ultra', 'invalid']),
  selectionReset: z.boolean().optional(),
  threadState: z.string(),
  pendingQuestions: z.number().int().nonnegative().nullable(),
  pendingConfirmation: z.boolean().nullable().default(false),
  chatPlan: z.object({ seq: z.number().int(), hash: z.string().length(64), title: z.string(), accepted: z.boolean() }).optional(),
  sessionBrief: z.object({ target: z.string(), status: z.enum(['stale', 'missing', 'research', 'invalid', 'blocked', 'valid', 'fresh']), seq: z.number() }).optional(),
  rulesSync: z.object({ command: z.string(), seq: z.number() }).optional(),
  fixDefaults: z.object({ mode: z.enum(['ask', 'now', 'plan']), patch: z.boolean() }).optional(),
  phase: phaseSchema, phaseSource: z.string(),
  versions: z.object({ globalCli: z.string().nullable(), globalSource: z.string().nullable(), installed: z.string().nullable(),
    sourceVersion: z.string().nullable(), sourceWorktreeVersion: z.string().nullable(), sourceSha: z.string().nullable(), sourceDirty: z.boolean().nullable() }),
  upstream: z.object({ version: z.string().nullable(), sha: z.string().nullable(), ref: z.string().nullable(), checkedAt: z.string().nullable(), error: z.string().nullable() }),
  extensions: z.array(z.object({ name: z.string(), recordedVersion: z.string().nullable(), installedVersion: z.string().nullable(),
    source: z.string(), state: z.enum(['present', 'missing', 'invalid', 'version_mismatch']), contributions: z.array(z.string()), commands: z.array(z.string()).optional() })),
  preparation: z.array(z.object({
    id: z.string(), label: z.string(), optional: z.boolean(), paths: z.array(z.string()),
    state: z.enum(['found', 'missing', 'unknown']),
  })).optional(),
  preparationVisible: z.boolean().optional(),
  skills: z.array(z.string()), candidates: z.array(z.object({ path: z.string(), title: z.string(), kind: z.string(), closed: z.boolean().optional(),
    progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), verified: z.boolean() }).optional() })),
  target: z.object({ path: z.string(), title: z.string(), id: z.string(), kind: z.enum(['fast', 'full', 'fix', 'ultra', 'classic', 'openspec', 'basic']),
    verification: z.object({ contentHash: z.string().length(64), verified: z.boolean() }).optional(),
    settings: z.object({ commitStrategy: z.enum(['incremental', 'incremental-at-end', 'single-commit']).nullable(),
      methodology: z.enum(['implementation-first', 'tdd']).nullable(), tddGranularity: z.enum(['task-based', 'feature-based']).nullable() }).optional(),
    tasks: z.array(z.object({ id: z.string(), title: z.string(), done: z.boolean(), kind: z.literal('commit').optional(), outcome: z.literal('skipped').optional() })) }).nullable(),
  checks: z.array(z.object({ id: z.string(), label: z.string(), state: z.enum(['notrun', 'reported-pass', 'warn', 'fail', 'unknown']),
    detail: z.string(), path: z.string().nullable(), required: z.boolean(),
    chat: z.object({ seq: z.number(), at: z.string(), target: z.string(),
      result: z.lazy(() => gateResultSchema), freshness: z.enum(['unknown', 'unchanged', 'changed']),
      inputFingerprint: z.string().length(64).optional(), observedAt: z.string().optional() }).optional() })),
  actions: z.array(actionSchema), readiness: z.array(readinessStepSchema).default([]), diagnostics: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Action = z.infer<typeof actionSchema>;
export type ReadinessStep = z.infer<typeof readinessStepSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type CardRequest = z.infer<typeof requestSchema>;
export const selectionSchema = z.object({ target: z.string().max(1000), phase: phaseSchema }).strict();
export const RESEARCH_TASK_MAX_LENGTH = 4000;
export const runSchema = requestSchema.extend({ fingerprint: z.string().length(64), actionId: z.string().min(1).max(100), requestId: z.string().uuid(),
  researchTask: z.string().trim().min(1).max(RESEARCH_TASK_MAX_LENGTH).optional(),
}).strict();
export const hostInputSchema = z.object({ root: z.string().min(1).max(4096), target: z.string().max(1000), phase: phaseSchema,
  runtime: z.string().max(100), sourceRepo: z.string().max(4096), checkUpdates: z.boolean(),
  upstreamRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), upstreamRef: z.string().max(200),
  cachedVersions: z.object({ versions: snapshotSchema.shape.versions, checkedAt: z.string() }).nullable().default(null),
}).strict();
export type HostInput = z.input<typeof hostInputSchema>;
export const suggestionRequestSchema = z.object({ threadId: z.string().min(1).max(200) }).strict();
export const cardIdSchema = z.string().uuid();
export const cardVisibilitySchema = suggestionRequestSchema.extend({ cardId: cardIdSchema }).strict();
export const suggestionActionSchema = suggestionRequestSchema.extend({
  sourceKey: z.string().length(64), commandId: z.union([z.string().max(100).regex(/^aif(?:-[a-z0-9]+)*$/), z.literal('apply-improvements')]),
}).strict();
export const gateResultSchema = z.object({
  schema_version: z.literal(1), gate: z.enum(['verify', 'review', 'security', 'rules']),
  status: z.enum(['pass', 'warn', 'fail']), blocking: z.boolean(),
  blockers: z.array(z.object({ id: z.string().min(1).max(200), severity: z.enum(['error', 'warning']),
    file: z.string().max(1000).nullable().optional(), summary: z.string().min(1).max(2000) })).max(100),
  affected_files: z.array(z.string().max(1000)).max(200),
  suggested_next: z.object({ command: z.string().max(150).nullable(), reason: z.string().max(2000).nullable() }).nullable().default(null),
});
export type GateResult = z.infer<typeof gateResultSchema>;
export const suggestionsSchema = z.object({
  sourceKey: z.string(), fingerprint: z.string(), threadState: z.string(),
  gate: gateResultSchema.nullable().default(null), gateError: z.string().nullable().default(null), gateWarning: z.string().nullable().optional(),
  // 'plan' when the reply had no commands and chips come from the plan's next steps.
  origin: z.enum(['reply', 'plan']).default('reply'),
  items: z.array(z.object({ id: z.string(), command: z.string(), available: z.boolean(), reason: z.string(), probability: z.number().min(0).max(1).nullable().default(null),
    label: z.string().optional(), kind: z.literal('improve-approval').optional() })),
});
export type Suggestions = z.infer<typeof suggestionsSchema>;
export const chipScoringStateSchema = z.object({
  enabled: z.boolean().default(false),
  source: z.enum(['catalog', 'manual']).default('catalog'),
  catalogName: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  lastScoredAt: z.number().nullable().default(null),
});
export type ChipScoringState = z.infer<typeof chipScoringStateSchema>;
export const RESEARCH_ROLES = ['research', 'research2', 'research3'] as const;
export type ResearchRole = typeof RESEARCH_ROLES[number];
export const delegationRoleSchema = z.enum(['implement', ...RESEARCH_ROLES]);
export type DelegationRole = z.infer<typeof delegationRoleSchema>;
export const DELEGATION_ROLES = ['implement', ...RESEARCH_ROLES] as const;

const id = z.string().regex(/^[\w.-]{1,100}$/);
export const delegationChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('self') }).strict(),
  z.object({ mode: z.literal('bb'), providerId: id, model: z.string().regex(/^[^\s?&#]{1,200}$/), reasoning: id.optional(), tier: id.optional(), parallel: z.number().int().min(2).max(4).optional() }).strict(),
]);
export type DelegationChoice = z.infer<typeof delegationChoiceSchema>;
export const delegationDefaultsSchema = z.object({ implement: delegationChoiceSchema, research: delegationChoiceSchema, research2: delegationChoiceSchema, research3: delegationChoiceSchema }).strict();
export type DelegationDefaults = z.infer<typeof delegationDefaultsSchema>;
export const delegationStateSchema = z.object({
  choice: delegationChoiceSchema,
  /** Model for research worker 1 (Explore) of every AI Factory skill; self = the agent's own subagent. */
  research: delegationChoiceSchema,
  /** Research workers 2 and 3; self = same as worker 1. */
  research2: delegationChoiceSchema,
  research3: delegationChoiceSchema,
  configured: z.boolean(),
  // phases.implement points at an agent this plugin does not manage.
  foreign: z.string().nullable(),
  error: z.string().nullable(),
  // Set only on the setDelegation response when legacy runner files were removed.
  removedLegacy: z.boolean().optional(),
});
export type DelegationState = z.infer<typeof delegationStateSchema>;

// Scout (/aif-scout): finding cards and checker result.
export const PLUGIN_SKILLS = ['aif-chat', 'aif-scout'] as const;
export type PluginSkill = typeof PLUGIN_SKILLS[number];
export const SCOUT_MODES = ['dev', 'ideas'] as const;
export type ScoutMode = typeof SCOUT_MODES[number];
export const SCOUT_DEPTHS = ['quick', 'normal', 'deep'] as const;
export type ScoutDepth = typeof SCOUT_DEPTHS[number];
export const SCOUT_ROLES = ['discovery', 'validation', 'constraint', 'measurement'] as const;
export type ScoutRole = typeof SCOUT_ROLES[number];
export const SCOUT_CAPTURE = ['full', 'excerpt', 'metadata_only', 'unavailable'] as const;
export type ScoutCapture = typeof SCOUT_CAPTURE[number];
export const SCOUT_STATUS = ['VERIFIED', 'REPORTED', 'SNIPPET_ONLY', 'INFERRED'] as const;
export type ScoutStatus = typeof SCOUT_STATUS[number];
export const SCOUT_CONFIDENCE = ['low', 'med', 'high'] as const;
export type ScoutConfidence = typeof SCOUT_CONFIDENCE[number];
export const SCOUT_ORIGIN = ['user', 'vendor', 'author', 'paper', 'unknown'] as const;
export type ScoutOrigin = typeof SCOUT_ORIGIN[number];
export const SCOUT_FINDING_TYPES = ['fact', 'opinion', 'pain', 'wish', 'workaround', 'metric', 'competitor-capability'] as const;
export type ScoutFindingType = typeof SCOUT_FINDING_TYPES[number];
export const SCOUT_DECISION_IMPACT = ['yes', 'no', 'unknown'] as const;
export type ScoutDecisionImpact = typeof SCOUT_DECISION_IMPACT[number];
export const SCOUT_SEVERITY = ['rare-critical', 'frequent-background', 'unknown'] as const;
export type ScoutSeverity = typeof SCOUT_SEVERITY[number];
export const SCOUT_VERDICTS = ['READY', 'READY_WITH_GAPS', 'NOT_READY'] as const;
export type ScoutVerdict = typeof SCOUT_VERDICTS[number];
export const SCOUT_COVERAGE = ['COVERED', 'PARTIAL', 'MISSING'] as const;
export type ScoutCoverage = typeof SCOUT_COVERAGE[number];
export const SCOUT_PROBLEM_CODES = [
  'schema',
  'orphan_card',
  'duplicate_id',
  'missing_required',
  'partial',
  'confidence_cap',
  'counter_missing',
  'inflation',
  'single_source_spread',
  'unsupported_claim',
  'unknown_ref',
  'forbidden_phrase',
  'report_section',
  'no_opportunities',
  'opportunity_incomplete',
  'market_both',
] as const;
export type ScoutProblemCode = typeof SCOUT_PROBLEM_CODES[number];

const scoutDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scoutAngleId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const scoutFindingId = z.string().regex(/^F\d{1,4}$/);
const scoutOpportunityId = z.string().regex(/^O\d{1,4}$/);

export const scoutAngleSchema = z.object({
  id: scoutAngleId,
  role: z.enum(SCOUT_ROLES),
  hypothesis: z.string().trim().min(1).max(500),
  mirror_of: scoutAngleId.optional(),
  required: z.boolean().default(true),
  market: z.string().trim().min(1).max(20).optional(),
}).strict();

export const scoutPlanSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  mode: z.enum(SCOUT_MODES),
  depth: z.enum(SCOUT_DEPTHS).default('normal'),
  as_of: scoutDate,
  angles: z.array(scoutAngleSchema).min(1).max(12)
    .refine(angles => new Set(angles.map(a => a.id)).size === angles.length, 'id углов должны быть уникальны'),
}).strict();

export const scoutEvidenceSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2000),
  capture: z.enum(SCOUT_CAPTURE),
  source_date: scoutDate.nullable().optional(),
  quote: z.string().trim().max(600).optional(),
}).strict();

export const scoutFindingSchema = z.object({
  id: scoutFindingId,
  claim: z.string().trim().min(1).max(600),
  type: z.enum(SCOUT_FINDING_TYPES),
  origin: z.enum(SCOUT_ORIGIN),
  evidence: z.array(scoutEvidenceSchema).min(1).max(10),
  market_lang: z.string().trim().min(1).max(20).optional(),
  version_scope: z.string().trim().max(200).optional(),
  status: z.enum(SCOUT_STATUS),
  confidence: z.enum(SCOUT_CONFIDENCE),
  changes_decision: z.enum(SCOUT_DECISION_IMPACT).default('unknown'),
  cannot_claim: z.string().trim().max(400).optional(),
}).strict();

export const scoutCardSchema = z.object({
  scout: scoutAngleId,
  as_of: scoutDate,
  tools: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  queries_run: z.number().int().nonnegative(),
  findings: z.array(scoutFindingSchema).max(50).default([]),
  counter_evidence: z.array(scoutFindingSchema).max(50).default([]),
  not_found: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  injection_suspected: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  open_questions: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
}).strict();

export const scoutOpportunitySchema = z.object({
  id: scoutOpportunityId,
  unmet_need: z.string().trim().min(1).max(400),
  user_context: z.string().trim().min(1).max(400),
  workaround_today: z.string().trim().min(1).max(400),
  why_existing_misses_it: z.string().trim().max(400).optional(),
  evidence: z.array(scoutFindingId).max(20).default([]),
  counterpoints: z.array(scoutFindingId).max(20).default([]),
  market: z.string().trim().min(1).max(20),
  severity: z.enum(SCOUT_SEVERITY).default('unknown'),
  next_check: z.string().trim().max(400).optional(),
  status: z.literal('draft').default('draft'),
}).strict();

export const scoutOpportunitiesSchema = z.object({
  opportunities: z.array(scoutOpportunitySchema).max(30),
}).strict();

export const scoutProblemSchema = z.object({
  code: z.enum(SCOUT_PROBLEM_CODES),
  severity: z.enum(['block', 'gap']),
  message: z.string(),
  ref: z.string().optional(),
});

export const scoutCheckSchema = z.object({
  verdict: z.enum(SCOUT_VERDICTS),
  mode: z.enum(SCOUT_MODES).nullable(),
  counts: z.object({
    sources: z.number().int().nonnegative(),
    full: z.number().int().nonnegative(),
    excerpt: z.number().int().nonnegative(),
    metadata_only: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    findings: z.number().int().nonnegative(),
  }),
  coverage: z.array(z.object({
    angle: z.string(),
    state: z.enum(SCOUT_COVERAGE),
  })),
  problems: z.array(scoutProblemSchema),
});

export type ScoutAngle = z.infer<typeof scoutAngleSchema>;
export type ScoutPlan = z.infer<typeof scoutPlanSchema>;
export type ScoutEvidence = z.infer<typeof scoutEvidenceSchema>;
export type ScoutFinding = z.infer<typeof scoutFindingSchema>;
export type ScoutCard = z.infer<typeof scoutCardSchema>;
export type ScoutOpportunity = z.infer<typeof scoutOpportunitySchema>;
export type ScoutProblem = z.infer<typeof scoutProblemSchema>;
export type ScoutCheck = z.infer<typeof scoutCheckSchema>;
