import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, useRealtime, useComposer, useBbNavigate, experimental_ProviderModelPicker as ProviderModelPicker, type ExperimentalProviderModelPickerValue as PickerValue, type PluginMessageDirectiveProps, type ExperimentalThreadContextCardProps, type ExperimentalThreadTabProps, type ExperimentalCodeFenceRendererProps, type PluginComposerApi } from '@get-bb/plugin-sdk/app';
import type { rpcContract, DelegationView } from './contract.ts';
import type { DelegationChoice } from './delegation.ts';
import { phaseSchema, type Snapshot, type Phase, type Action, type ReadinessStep, type Suggestions } from './model.ts';
import { readinessComplete, nextReadinessStep } from './readiness.ts';
import { parseReplyGate } from './gate.ts';
import { rowActions, supplementaryChecks } from './check-actions.ts';
import { updateInVersionDetails, VERSION_TTL } from './versions.ts';
import { contextSetupInDetails } from './workflow.ts';
import { chipDraft } from './suggestions.ts';
import { BASIC_PLAN_ROOT, usesBasicWorkflow } from './basic-workflow.ts';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { Callout, Disclosure, Hint, Section, StatusDot, type Tone } from '@/components/aif/layout';
import './aif-chat.css';

const phaseNames: Record<Phase, string> = { unknown: 'Контекст задачи', explore: 'Исследование', plan: 'Планирование', improve: 'Уточнение плана', implement: 'Выполнение плана', verify: 'Проверка', fix: 'Исправление замечаний', done: 'Финализация' };
const profileNames: Record<Snapshot['profile'], string> = { none: 'Нет установки', upstream: 'AI Factory', 'aifhub-classic': 'AIFHub · classic', 'aifhub-openspec': 'AIFHub · OpenSpec', 'aifhub-ultra': 'AIFHub · legacy ultra', invalid: 'Проверьте конфигурацию' };
const checkLabels = { notrun: 'Нет evidence', 'reported-pass': 'PASS в отчёте', warn: 'С замечаниями', fail: 'Ошибка', unknown: 'Не подтверждено' };

function GateData({ code, status, Original }: ExperimentalCodeFenceRendererProps) {
  const parsed = status === 'closed' ? parseReplyGate(`\`\`\`aif-gate-result\n${code}\n\`\`\``) : null;
  const error = status === 'unclosed' ? 'Блок aif-gate-result не закрыт; результат не подтверждён.' : parsed?.error;
  const gate = parsed && !error ? parsed.gate : null;
  return <div className="aif-gate-data">
    {error && <p className="aif-error" role="alert">Некорректный gate: {error}</p>}
    <details><summary>Данные gate{gate ? ` · ${gate.gate} · ${gate.status.toUpperCase()}` : status === 'streaming' ? ' · формируются…' : ' · проверить JSON'}</summary>
      <Original />
    </details>
  </div>;
}

function WorkflowCard({ threadId, initialTarget = '', phase = 'unknown', openFile, compact = false, delegation = false, environmentId = null }: {
  threadId: string; initialTarget?: string; phase?: Phase; openFile?: ((path: string) => boolean) | null; compact?: boolean; delegation?: boolean; environmentId?: string | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [target, setTarget] = useState(initialTarget);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [network, setNetwork] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const sendingRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => { setTarget(initialTarget); setSnapshot(null); }, [initialTarget, threadId]);
  const refresh = useCallback(async (checkUpdates = false, force = false) => {
    const id = ++sequence.current;
    try {
      const value = await rpc.call('status', { threadId, target, phase, checkUpdates, force });
      if (mounted.current && id === sequence.current) {
        setSnapshot(value); setError('');
        if (value.configured && target.startsWith(BASIC_PLAN_ROOT + '/')) setTarget('');
      }
    } catch (e) {
      if (mounted.current && id === sequence.current) { setError(e instanceof Error ? e.message : String(e)); setSnapshot(null); }
    } finally { if (mounted.current && id === sequence.current) setLoading(false); }
  }, [rpc, threadId, target, phase]);
  useEffect(() => {
    setLoading(true); void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    return () => window.clearInterval(interval);
  }, [refresh]);
  useRealtime('changed', (payload: unknown) => { if ((payload as { threadId?: string })?.threadId === threadId) void refresh(); });
  async function run(action: Action) {
    if (!snapshot || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setError(''); setNotice('');
    try {
      const result = await rpc.call('run', { threadId, target: snapshot.target?.path ?? target, phase: snapshot.phase,
        fingerprint: snapshot.fingerprint, actionId: action.id, requestId: crypto.randomUUID() });
      if (mounted.current) setNotice(result.message);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { sendingRef.current = false; if (mounted.current) { setSending(false); void refresh(); } }
  }
  const setReadinessSkip = async (stepId: 'quality' | 'ci', skipped: boolean) => {
    try { await rpc.call('setReadinessSkip', { threadId, stepId, skipped }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
    await refresh();
  };
  const busy = !!snapshot && !['idle', 'error'].includes(snapshot.threadState);
  const tasks = snapshot?.target?.tasks ?? [];
  const completed = tasks.filter(t => t.done).length;
  const nextVersionCheck = snapshot?.upstream.checkedAt ? Date.parse(snapshot.upstream.checkedAt) + VERSION_TTL : 0;
  // One primary action per card: the first "next" step. Everything else is outline.
  // In the tab the readiness block owns its steps' actions, so they never take primary styling there.
  const readinessActionIds = new Set(snapshot?.readiness.map(s => s.actionId) ?? []);
  const primaryId = snapshot && (snapshot.actions.find(a => a.group === 'next' && a.available)
    ?? snapshot.actions.find(a => a.group === 'maintenance' && a.available && !updateInVersionDetails(snapshot, a.id) && !contextSetupInDetails(snapshot, a.id) && !(delegation && readinessActionIds.has(a.id))))?.id;
  const renderAction = (a: Action) => <Hint key={a.id} text={`${a.reason}\n${a.command}`}><Button type="button" size="sm" variant={a.id === primaryId ? 'default' : 'outline'}
    disabled={sending || busy || !a.available} onClick={() => void run(a)}>
    {a.label}{!a.available && (a.disabledReason === 'unchanged' ? ' · без изменений' : ' · не установлен')}</Button></Hint>;
  const renderActions = (actions: Action[]) => actions.length ? <div className="flex flex-wrap gap-2">{actions.map(renderAction)}</div> : null;
  const stateText = snapshot ? snapshot.pendingQuestions ? `ожидаю ответы: ${snapshot.pendingQuestions}` : busy ? 'агент занят' : snapshot.threadState === 'error' ? 'ошибка выполнения BB' : 'агент свободен' : '';
  const checkTone = (c: Snapshot['checks'][number]) => {
    const state = c.chat ? c.chat.result.status : c.state;
    return state === 'fail' ? 'destructive' : state === 'pass' || state === 'reported-pass' ? 'default' : 'secondary';
  };
  return <section aria-label="AI Factory workflow" className={cn('aif-card flex min-w-0 flex-col gap-4 text-sm text-foreground [overflow-wrap:anywhere]',
    compact ? '' : 'my-3 rounded-xl border border-border bg-card p-4')}>
    <header className={cn('flex min-h-8 items-center gap-2', delegation && 'sticky -top-4 z-10 -mx-4 -mt-4 border-b border-border bg-background/90 px-4 py-3 backdrop-blur')}>
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><Icon name="Workflow" className="size-3.5" /></span>
      <strong className="text-base font-semibold tracking-tight whitespace-nowrap">AI Factory</strong>
      {snapshot && <Badge variant="secondary" className="truncate font-medium">{profileNames[snapshot.profile]}</Badge>}
      <span className="ml-auto"><Hint text="Перечитать задачи и проверки; версии CLI/Git и GitHub кэшируются на сутки"><Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => void refresh(false, true)}
        aria-label="Обновить статус AI Factory"><Icon name="RotateCcw" className="size-4" /></Button></Hint></span>
    </header>
    {loading && <div role="status" aria-label="Читаю локальный статус…" className="h-24 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />}
    {error && <Callout tone="error" role="alert">{error}</Callout>}
    {notice && <Callout role="status">{notice}</Callout>}
    {snapshot && <>
      <div className="aif-versions flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span>CLI <b className="font-semibold text-foreground">{snapshot.versions.globalCli ?? 'не найден'}</b></span>
        <span>Проект <b className="font-semibold text-foreground">{snapshot.versions.installed ?? 'не указан'}</b></span>
        {snapshot.versions.sourceVersion && <span>Git <b className="font-semibold text-foreground">{snapshot.versions.sourceVersion}</b> @{snapshot.versions.sourceSha?.slice(0, 7)}{snapshot.versions.sourceDirty ? ' · изменён' : ''}</span>}
        {snapshot.extensions.map(e => <span key={e.name} title={e.installedVersion ? 'Установленная версия расширения' : 'Записанная версия; установленные файлы не подтверждены'}>{e.name} <b className="font-semibold text-foreground">{e.installedVersion ?? e.recordedVersion ?? 'неизвестна'}</b>{!e.installedVersion && ' · не подтверждена'}</span>)}
      </div>

      {delegation && snapshot.readiness.length > 0 && <ReadinessSection snapshot={snapshot} run={run} busy={busy} sending={sending} setReadinessSkip={setReadinessSkip} />}

      <Section label="Текущий этап" title="Сейчас">
        <p className="m-0 flex flex-wrap items-center gap-2" title={snapshot.phaseSource}>
          <StatusDot tone={busy ? 'live' : snapshot.threadState === 'error' ? 'error' : 'idle'} />
          <span className="font-medium">{phaseNames[snapshot.phase]} <span className="font-normal text-muted-foreground">· {stateText}</span></span>
        </p>
        {usesBasicWorkflow(snapshot) && <p aria-label="Базовый workflow" className="m-0 text-xs text-muted-foreground">Без AI Factory доступен встроенный flow: исследование → план → выполнение → проверка → коммит. Установка — отдельная кнопка; планы сохраняются в .bb-aif-helper/plans/.</p>}
        {snapshot.candidates.length > 0 && <label className="flex flex-col gap-1 text-xs text-muted-foreground">План / change
          <select aria-label="Выбранный план или change" value={snapshot.target?.path ?? target} onChange={e => { setTarget(e.target.value); setNotice(''); }}
            className="h-9 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {!snapshot.target && <option value="">Выберите задачу</option>}
            {snapshot.candidates.map(t => <option key={t.path} value={t.path}>{t.title} · {t.kind}</option>)}
          </select></label>}
        {snapshot.target && <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-3"><strong className="font-medium">{snapshot.target.title}</strong>
            <span className="text-xs text-muted-foreground tabular-nums">{completed}/{tasks.length} задач</span></div>
          <Progress aria-label="Выполнение задач плана" value={tasks.length ? completed / tasks.length * 100 : 0} className="h-1.5 bg-muted" />
          <Disclosure summary="Задачи плана">
            {tasks.length ? <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{tasks.map((t, i) => <li key={`${t.id}-${i}`} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 text-xs">
              <Icon name={t.done ? 'CircleCheck' : 'Circle'} aria-label={t.done ? 'Выполнена по плану' : 'Не выполнена'} className={cn('mt-px size-4', t.done ? 'text-primary' : 'text-muted-foreground')} />
              <span className={t.done ? 'text-muted-foreground' : ''}>{t.title}</span></li>)}</ul>
              : <p className="m-0 text-xs text-muted-foreground">Чекбоксы задач не найдены; прогресс неизвестен.</p>}
          </Disclosure>
        </div>}
        {renderActions(snapshot.actions.filter(a => a.group === 'next').slice(0, 3))}
        {(() => { const items = snapshot.actions.filter(a => a.group === 'maintenance' && !updateInVersionDetails(snapshot, a.id) && !contextSetupInDetails(snapshot, a.id) && !(delegation && a.id === 'setup-context'));
          return items.length ? <div className="aif-maintenance" role="group" aria-label="Обновление и настройка AI Factory">{renderActions(items)}</div> : null; })()}
        {!delegation && snapshot.actions.some(a => contextSetupInDetails(snapshot, a.id)) && <Disclosure className="aif-context-setup" summary="Настройка контекста проекта">
          <p className="m-0 text-xs text-muted-foreground">Выполнение плана уже начато. Настройка контекста запускается отдельно и не продолжает выбранный план.</p>
          {renderActions(snapshot.actions.filter(a => contextSetupInDetails(snapshot, a.id)))}
        </Disclosure>}
      </Section>

      {delegation && snapshot.configured && <DelegationSection threadId={threadId} environmentId={environmentId} busy={busy} />}

      {snapshot.target && snapshot.checks.length > 0 && <Disclosure className="aif-checks" summary={<>Что проверить <span className="font-normal text-muted-foreground">· из чата: {snapshot.checks.filter(c => c.chat).length} · отчётов PASS: {snapshot.checks.filter(c => c.state === 'reported-pass').length}</span></>}>
        <p className="m-0 text-xs text-muted-foreground">Дополнительные проверки — по выбору. Правила проекта и обязательные gates могут требовать их перед завершением; блокирующий FAIL сохраняет силу. Галочки задач и результаты проверок независимы. Актуальность evidence подтверждает владелец workflow.</p>
        <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-lg border border-border p-0">{snapshot.checks.map(c => <li key={c.id} className="flex flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="font-medium">{c.label}</strong>
            {c.required ? <span className="text-xs text-muted-foreground">нужно для завершения</span> : supplementaryChecks.has(c.id) && <span className="text-xs text-muted-foreground" title="Дополнительный шаг flow; действующие правила проекта сохраняют приоритет">по выбору</span>}
            <Badge variant={checkTone(c)} className="ml-auto" title={c.detail}>{c.chat ? `${c.chat.result.status.toUpperCase()} · из чата` : checkLabels[c.state]}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {snapshot.actions.filter(a => a.id === rowActions[c.id]).map(renderAction)}
            {c.path && openFile && <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => { if (!openFile(c.path!)) setError('Просмотр файла недоступен в этой поверхности.'); }}>Отчёт</Button>}
          </div>
          {c.chat && <p className="m-0 text-xs text-muted-foreground">Gate завершён · {new Date(c.chat.at).toLocaleString('ru')} · сообщение #{c.chat.seq}. {c.chat.freshness === 'unchanged'
            ? 'С момента фиксации результата файлы не изменились. Повторная проверка заблокирована.'
            : c.chat.freshness === 'changed' ? 'Файлы изменились после фиксации результата; можно проверить повторно.' : 'Актуальность для текущих файлов не подтверждена.'}
            {c.chat.result.blocking ? ' Есть блокирующие проблемы.' : ' Блокеров нет.'}
            {c.chat.result.blockers.map(b => <span key={b.id}>{` ${b.id}: ${b.summary}${b.file ? ` (${b.file})` : ''}`}</span>)}
            {c.chat.result.suggested_next?.reason && <span>{` ${c.chat.result.suggested_next.reason}`}</span>}</p>}
          <p className="m-0 text-xs text-muted-foreground">{c.chat ? `Файловый отчёт: ${c.path ? checkLabels[c.state] + '. ' + c.detail : 'не найден.'}` : c.detail}</p>
        </li>)}</ul>
        <Disclosure summary="Настройка инструментов">{renderActions(snapshot.actions.filter(a => a.group === 'setup' && (a.id === 'quality-setup' || a.id === 'ci-setup')))}</Disclosure>
      </Disclosure>}

      <Disclosure className="aif-details" summary={<>Версии и расширения{snapshot.extensions.length ? <span className="font-normal text-muted-foreground"> · {snapshot.extensions.length}</span> : null}</>}>
        {renderActions(snapshot.actions.filter(a => a.group === 'maintenance' && updateInVersionDetails(snapshot, a.id)))}
        {snapshot.versionsCheckedAt && <p className="m-0 text-xs text-muted-foreground">Версии CLI/Git: снимок от {new Date(snapshot.versionsCheckedAt).toLocaleString('ru')}. Плановая проверка — раз в сутки.</p>}
        <dl className="m-0 grid grid-cols-[minmax(96px,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2 text-xs [&_dd]:m-0 [&_dt]:text-muted-foreground [&_small]:block [&_small]:text-muted-foreground">
          <dt>Глобальный CLI</dt><dd>{snapshot.versions.globalCli ?? 'Не найден'}{snapshot.versions.globalSource && <small>{snapshot.versions.globalSource}</small>}</dd>
          <dt>Установка проекта</dt><dd>{snapshot.versions.installed ?? 'Не указана'} · {snapshot.runtime}</dd>
          <dt>Исходники Git</dt><dd>{snapshot.versions.sourceVersion ?? 'Checkout не задан'}{snapshot.versions.sourceSha && <small>{snapshot.versions.sourceSha}</small>}
            {snapshot.versions.sourceWorktreeVersion && snapshot.versions.sourceWorktreeVersion !== snapshot.versions.sourceVersion && <small>Рабочее дерево: {snapshot.versions.sourceWorktreeVersion}</small>}</dd>
          <dt>Git upstream</dt><dd>{snapshot.upstream.version ?? 'Не проверен'}{snapshot.upstream.ref && ` · ${snapshot.upstream.ref} @${snapshot.upstream.sha?.slice(0, 7)}`}
            {snapshot.upstream.checkedAt && <small>Проверено {new Date(snapshot.upstream.checkedAt).toLocaleString()}</small>}{snapshot.upstream.error && <small>{snapshot.upstream.error}</small>}</dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <Hint text={nextVersionCheck > Date.now() ? `Следующая проверка доступна ${new Date(nextVersionCheck).toLocaleString('ru')}` : 'Проверить upstream; результат сохраняется на сутки'}><Button type="button" variant="outline" size="sm" disabled={network || nextVersionCheck > Date.now()}
            onClick={async () => { setNetwork(true); try { await refresh(true); } finally { if (mounted.current) setNetwork(false); } }}>{network ? 'Проверяю GitHub…' : 'Проверить версию в GitHub'}</Button></Hint>
          {nextVersionCheck > Date.now() && <span className="text-xs text-muted-foreground">Следующая проверка GitHub — {new Date(nextVersionCheck).toLocaleString('ru')}.</span>}
        </div>
        {snapshot.extensions.length ? <ul className="m-0 flex list-none flex-col gap-3 p-0 text-xs">{snapshot.extensions.map(e => <li key={e.name}><strong className="font-medium">{e.name}</strong> {e.installedVersion ?? 'файлы отсутствуют'} <span className="text-muted-foreground">· {e.state}</span>
          <small className="block text-muted-foreground">Записано: {e.recordedVersion ?? 'не указано'} · {e.source}</small>{e.contributions.length > 0 && <small className="block text-muted-foreground">Настроенные injections: {e.contributions.join(', ')}. Это не подтверждение загрузки в текущую сессию.</small>}</li>)}</ul>
          : <p className="m-0 text-xs text-muted-foreground">Расширения не зарегистрированы в этом проекте.</p>}
      </Disclosure>
      {snapshot.diagnostics.length > 0 && <Disclosure summary={`Примечания · ${snapshot.diagnostics.length}`}>
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-xs text-muted-foreground">{snapshot.diagnostics.map((d, i) => <li key={i}>{d}</li>)}</ul>
      </Disclosure>}
      <footer className="border-t border-border pt-3 text-xs text-muted-foreground">{snapshot.cache?.source === 'saved' ? 'Сохранённые данные' : snapshot.cache?.source === 'memory' ? 'Данные из кэша' : 'Локальный статус'} · {new Date(snapshot.collectedAt).toLocaleTimeString()}
        {snapshot.cache?.refreshing && ' · обновляются в фоне…'}{snapshot.cache?.refreshError && ' · обновление не удалось; нажмите обновить для повторного чтения'} · {busy ? 'действия доступны после завершения работы' : 'кнопки отправляют выбранную команду в этот чат'}</footer>
    </>}
  </section>;
}

const childStatus: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'в очереди', tone: 'idle' }, starting: { label: 'запускается', tone: 'live' }, active: { label: 'пишет код', tone: 'live' },
  stopping: { label: 'останавливается', tone: 'live' }, idle: { label: 'готово', tone: 'done' }, error: { label: 'ошибка', tone: 'error' },
};
const toPicker = (c: Extract<DelegationChoice, { mode: 'bb' }>): PickerValue =>
  ({ providerId: c.providerId, model: c.model, reasoningLevel: (c.reasoning ?? 'medium') as PickerValue['reasoningLevel'], ...(c.tier ? { serviceTier: c.tier as PickerValue['serviceTier'] } : {}) });
const fromPicker = (v: PickerValue): DelegationChoice =>
  ({ mode: 'bb', providerId: v.providerId, model: v.model, ...(v.reasoningLevel ? { reasoning: v.reasoningLevel } : {}), ...(v.serviceTier && v.serviceTier !== 'default' ? { tier: v.serviceTier } : {}) });
// Starting point for the picker; it immediately reconciles to a real model from the live catalog.
const pickerSeed: PickerValue = { providerId: 'codex', model: '', reasoningLevel: 'high' as PickerValue['reasoningLevel'] };

function DelegationSection({ threadId, environmentId, busy }: { threadId: string; environmentId: string | null; busy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [view, setView] = useState<DelegationView | null>(null);
  const [mode, setMode] = useState<'self' | 'bb' | null>(null);
  const [pick, setPick] = useState<PickerValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const next = await rpc.call('delegation', { threadId });
      if (!mounted.current) return;
      setView(next); setError('');
      setMode(current => current ?? next.choice.mode);
      setPick(current => current ?? (next.choice.mode === 'bb' ? toPicker(next.choice) : null));
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
  }, [rpc, threadId]);
  useEffect(() => { void load(); }, [load]);
  useRealtime('changed', (payload: unknown) => { if ((payload as { threadId?: string })?.threadId === threadId) void load(); });
  if (!view || !mode) return <Section label="Исполнитель кода" title="Исполнитель кода">
    {error ? <p className="m-0 text-xs text-muted-foreground">Настройка недоступна: {error}</p> : <div className="h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" aria-hidden="true" />}
  </Section>;
  const choice: DelegationChoice | null = mode === 'self' ? { mode: 'self' } : pick?.model ? fromPicker(pick) : null;
  const dirty = !!choice && JSON.stringify(choice) !== JSON.stringify(view.choice);
  const providerName = (id: string | null) => view.providers.find(p => p.id === id)?.name ?? id;
  const active = view.choice;
  const savedLabel = active.mode === 'bb' ? [providerName(active.providerId), active.model, active.reasoning].filter(Boolean).join(' · ') : 'агент этого чата';
  const reset = () => { setMode(view.choice.mode); setPick(view.choice.mode === 'bb' ? toPicker(view.choice) : null); setError(''); };
  async function save() {
    if (!choice) return;
    setSaving(true); setError('');
    try {
      const next = await rpc.call('setDelegation', { threadId, choice });
      if (!mounted.current) return;
      setView(next); setMode(next.choice.mode); setPick(next.choice.mode === 'bb' ? toPicker(next.choice) : null);
      toast.success(next.choice.mode === 'bb' ? '/aif-implement будет передавать задачи выбранной модели.' : 'Код снова пишет агент этого чата.');
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current) setSaving(false); }
  }
  const locked = saving || !!view.foreign;
  return <Section label="Исполнитель кода" title="Исполнитель кода" aside={<Badge variant="secondary" className="max-w-[60%] truncate font-medium">{savedLabel}</Badge>}>
    {view.foreign && <Callout>phases.implement в .ai-factory.json настроен на агента «{view.foreign}». Панель его не меняет.</Callout>}
    {view.error && <Callout tone="error">{view.error}</Callout>}
    <div role="radiogroup" aria-label="Кто пишет код" className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5">
      {(['self', 'bb'] as const).map(m => <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={locked}
        onClick={() => { setError(''); setMode(m); if (m === 'bb' && !pick) setPick(pickerSeed); }}
        className={cn('h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
          mode === m ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}>{m === 'self' ? 'Этот агент' : 'Другая модель'}</button>)}
    </div>
    {mode === 'bb' && pick && <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">Провайдер и модель</span>
      <ProviderModelPicker value={pick} onChange={setPick} disabled={locked} align="start"
        routing={environmentId ? { kind: 'environment', environmentId } : undefined} className="max-w-full" />
    </div>}
    {dirty && <div className="flex flex-wrap gap-2">
      <Hint text={busy ? 'Дождитесь, пока агент закончит текущую работу' : 'Записать выбор в .ai-factory.json'}><Button type="button" size="sm" disabled={saving || busy || !!view.foreign} onClick={() => void save()}>{saving ? 'Сохраняю…' : 'Сохранить'}</Button></Hint>
      <Button type="button" size="sm" variant="outline" disabled={saving} onClick={reset}>Отменить</Button>
    </div>}
    {error && <Callout tone="error" role="status">{error}</Callout>}
    <p className="m-0 text-xs text-muted-foreground">Выбор хранится в .ai-factory.json → phases.implement. /aif-implement отдаёт каждую задачу дочернему треду на этой модели, затем сам проверяет diff и отмечает задачу в плане.</p>
    {view.children.length > 0 && <div className="flex flex-col gap-2">
      <h4 className="m-0 text-xs font-medium text-muted-foreground">Дочерние треды · {view.children.length}</h4>
      <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-md border border-border p-0">{view.children.map(c => {
        const st = childStatus[c.status] ?? { label: c.status, tone: 'idle' as const };
        return <li key={c.id} className="grid min-h-10 grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
          <StatusDot tone={st.tone} />
          <span className="min-w-0"><span className="block truncate">{c.title || 'Без названия'}</span>
            <span className="block truncate text-xs text-muted-foreground">{[providerName(c.providerId), st.label].filter(Boolean).join(' · ')}</span></span>
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => navigate.toThread(c.id, { split: true })}>
            Открыть<Icon name="ExternalLink" className="size-3.5" /></Button>
        </li>;
      })}</ul>
    </div>}
  </Section>;
}

function ReadinessSection({ snapshot, run, busy, sending, setReadinessSkip }: {
  snapshot: Snapshot; run: (action: Action) => void; busy: boolean; sending: boolean;
  setReadinessSkip: (stepId: 'quality' | 'ci', skipped: boolean) => Promise<void>;
}) {
  const [pendingSkip, setPendingSkip] = useState<string | null>(null);
  const steps = snapshot.readiness;
  const next = nextReadinessStep(steps);
  const actionFor = (s: ReadinessStep) => snapshot.actions.find(a => a.id === s.actionId);
  const iconFor = (s: ReadinessStep) => s.state === 'done' ? 'CircleCheck' : s.state === 'skipped' ? 'CircleDashed' : 'Circle';
  const stateLabel = (s: ReadinessStep) => s.state === 'done' ? 'Выполнен' : s.state === 'skipped' ? 'Пропущен' : 'Ожидает очереди';
  async function toggleSkip(s: ReadinessStep, skipped: boolean) {
    if (pendingSkip) return;
    setPendingSkip(s.id);
    try { await setReadinessSkip(s.id as 'quality' | 'ci', skipped); }
    finally { setPendingSkip(null); }
  }
  function stepRow(s: ReadinessStep, n: number, isNext: boolean) {
    const action = isNext ? actionFor(s) : undefined;
    const skip = s.state === 'skipped'
      ? <Button type="button" size="sm" variant="ghost" disabled={pendingSkip !== null} onClick={() => void toggleSkip(s, false)}>Вернуть</Button>
      : s.skippable && s.state === 'todo'
        ? <Button type="button" size="sm" variant="ghost" disabled={pendingSkip !== null} onClick={() => void toggleSkip(s, true)}>Пропустить</Button>
        : null;
    return <li key={s.id} className="flex items-start gap-2">
      <Icon name={iconFor(s)} aria-label={stateLabel(s)} className={cn('mt-0.5 size-4 shrink-0', s.state === 'done' ? 'text-primary' : 'text-muted-foreground')} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className="text-xs tabular-nums text-muted-foreground">{n}.</span>
          <span className={cn('text-sm font-medium', s.state === 'done' && 'text-muted-foreground')}>{s.label}</span>
          {skip && <span className="ml-auto">{skip}</span>}
        </span>
        {s.state === 'todo' && s.missing.length > 0 && <span className="text-xs text-muted-foreground">{s.anyOf ? 'любой из' : 'нет'}: {s.missing.join(', ')}</span>}
        {action && <span><Hint text={`${action.reason}\n${action.command}`}><Button type="button" size="sm"
          disabled={sending || busy || !action.available} onClick={() => void run(action)}>
          {action.label}{!action.available && (action.disabledReason === 'unchanged' ? ' · без изменений' : ' · не установлен')}</Button></Hint></span>}
      </div>
    </li>;
  }
  const list = <ol className="m-0 flex list-none flex-col gap-2 p-0">{steps.map((s, i) => stepRow(s, i + 1, next?.id === s.id))}</ol>;
  if (readinessComplete(steps)) return <Disclosure summary="Проект готов к работе через AI Factory">{list}</Disclosure>;
  return <Section label="Подготовка проекта" title="Подготовка проекта">
    <p className="m-0 text-xs text-muted-foreground">Выполните шаги по порядку, чтобы AI Factory работал полностью</p>
    {list}
  </Section>;
}

function Directive(props: PluginMessageDirectiveProps) {
  const parsed = phaseSchema.safeParse(props.attributes.phase ?? 'unknown');
  if (!parsed.success || (props.attributes.target?.length ?? 0) > 1000) return <p className="aif-error">Некорректная карточка AI Factory.</p>;
  return <WorkflowCard threadId={props.message.threadId} initialTarget={props.attributes.target ?? ''} phase={parsed.data} openFile={props.openWorkspaceFile} />;
}
function ContextCard({ threadId }: ExperimentalThreadContextCardProps) { return <WorkflowCard threadId={threadId} compact />; }
function WorkflowPanel({ threadId, environment }: ExperimentalThreadTabProps) { return <div className="aif-panel h-full min-h-0 overflow-y-auto overscroll-contain p-4 pb-8"><WorkflowCard key={threadId} threadId={threadId} environmentId={environment?.id ?? null} compact delegation /></div>; }
function SuggestedCommands() {
  const composer = useComposer();
  return composer.scope.kind === 'thread' ? <SuggestionBar key={composer.scope.threadId} threadId={composer.scope.threadId} composer={composer} composerBusy={composer.isRunning || composer.isSubmitting} /> : null;
}
function SuggestionBar({ threadId, composer, composerBusy }: { threadId: string; composer: PluginComposerApi; composerBusy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Suggestions | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const mounted = useRef(true);
  const operation = useRef(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const next = await rpc.call('suggestions', { threadId });
      if (mounted.current && sequence.current === id) setData(next);
    } catch { if (mounted.current && sequence.current === id) setData(null); }
  }, [rpc, threadId]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer); };
  }, [refresh]);
  useRealtime('changed', (payload: unknown) => { if ((payload as { threadId?: string })?.threadId === threadId) void refresh(); });
  async function act(id: string, dismiss: boolean) {
    if (!data || operation.current) return;
    operation.current = true; setWorking(true); setError(''); setNotice('');
    try {
      const input = { threadId, sourceKey: data.sourceKey, commandId: id };
      if (dismiss) await rpc.call('dismissSuggestion', input);
      else {
        const result = await rpc.call('runSuggestion', { ...input, fingerprint: data.fingerprint, requestId: crypto.randomUUID() });
        if (result.stale || !result.command) { if (mounted.current) setNotice(result.message); return; }
        const next = chipDraft(composer.draft, result.command, id);
        composer.replace({ text: next.text, mentions: next.mentions });
        if (next.submit) await composer.submit({ experimental_mode: 'queue-if-active', experimental_data: result.data ?? null });
        else composer.focus();
        await rpc.call('dismissSuggestion', input);
        if (mounted.current && !next.submit) setNotice(result.message);
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { await refresh(); operation.current = false; if (mounted.current) setWorking(false); }
  }
  const busy = composerBusy || !!data && !['idle', 'error'].includes(data.threadState);
  if (!data?.items.length && !data?.gate && !data?.gateError && !error && !notice) return null;
  return <section className="aif-suggestions" aria-label="Команды из последнего ответа агента">
    {(data?.gate || data?.gateError) && <div className={`aif-message-gate${data.gate?.blocking || data.gateError ? ' aif-message-gate-blocking' : ''}`} role="group" aria-label="Gate из последнего ответа">
      {data.gate && <><div className="aif-message-gate-heading"><strong>{data.gate.gate} · {data.gate.status.toUpperCase()} в ответе</strong><span>{data.gate.blocking ? 'Блокирует следующий этап' : 'Не блокирует'}</span></div>
        <p className="aif-muted aif-small">Заявленный результат из чата. Актуальность evidence для текущих inputs проверяет владелец workflow.</p>
        {data.gate.blockers.length ? <details open><summary>Блокирующие проблемы · {data.gate.blockers.length}</summary><ul>{data.gate.blockers.map((b, i) => <li key={`${b.id}-${i}`}><strong>{b.id}</strong> <span className="aif-muted">· {b.severity}</span><p>{b.summary}</p>{b.file && <code>{b.file}</code>}</li>)}</ul></details> : <p className="aif-small">Блокирующих проблем нет.</p>}
        {data.gate.suggested_next?.reason && <p className="aif-small"><strong>{data.gate.suggested_next.command ? 'Следующий шаг: ' : 'Пояснение: '}</strong>{data.gate.suggested_next.reason}</p>}
        {!!data.gate.affected_files.length && <details><summary>Затронутые файлы · {data.gate.affected_files.length}</summary><ul>{data.gate.affected_files.map((file, i) => <li key={i}><code>{file}</code></li>)}</ul></details>}
      </>}
      {data.gateError && <p className="aif-error" role="alert">Некорректный gate: {data.gateError}</p>}
    </div>}
    {!!data?.items.length && <><span className="aif-suggestions-label">Из ответа агента</span><div className="aif-suggestion-list">{data.items.map(item => <div className="aif-suggestion" key={item.id}>
      <button type="button" className="aif-suggestion-run" disabled={working || busy || !item.available}
        title={busy ? 'Дождитесь завершения текущей работы' : composer.isEmpty ? item.reason : `${item.command} + ваш текст из поля`}
        aria-label={composer.isEmpty ? undefined : `${item.command} + ваш текст из поля`}
        onClick={() => void act(item.id, false)}>{item.command}</button>
      <button type="button" className="aif-suggestion-dismiss" disabled={working} aria-label={`Удалить предложение ${item.command}`} title="Убрать из предложений этого ответа" onClick={() => void act(item.id, true)}>×</button>
    </div>)}</div></>}
    {error && <p className="aif-error" role="alert">{error}</p>}
    {notice && <p className="aif-muted aif-small" role="status">{notice}</p>}
  </section>;
}
export default definePluginApp(app => {
  app.slots.experimental_codeFenceRenderer({ id: 'gate-data', languages: ['aif-gate-result'], component: GateData });
  app.composer.customize({ id: 'suggested-commands', scopes: ['thread'], banners: [{ id: 'commands', chrome: 'bare', component: SuggestedCommands }] });
  app.slots.messageDirective({ id: 'aif-chat', component: Directive });
  app.slots.experimental_threadContextCardSection({ id: 'workflow', title: 'AI Factory', group: '9_aif', order: 10, component: ContextCard });
  app.slots.experimental_tab({ id: 'workflow', context: { kind: 'thread' }, availability: 'fixed', title: 'AI Factory', icon: 'Workflow', layout: 'flush', component: WorkflowPanel });
  app.slots.experimental_threadAction({
    id: 'open-workflow', title: 'AI Factory', icon: 'Workflow', group: '0_aif', placement: 'header',
    item: ({ experimental_panel }) => ({
      label: 'AI Factory', icon: 'Workflow', detail: 'Версии, workflow и прогресс проверок',
      run: () => { experimental_panel.openTab({ tab: { id: 'workflow', context: { kind: 'thread' }, availability: 'fixed' } }); },
    }),
  });
});
