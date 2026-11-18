import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { definePluginApp, useRpc, useRealtime, useComposer, useBbNavigate, experimental_ProviderModelPicker as ProviderModelPicker, type ExperimentalProviderModelPickerValue as PickerValue, type PluginMessageDirectiveProps, type ExperimentalThreadContextCardProps, type ExperimentalThreadTabProps, type ExperimentalCodeFenceRendererProps, type PluginComposerApi } from '@get-bb/plugin-sdk/app';
import type { rpcContract, DelegationView } from './contract.ts';
import type { DelegationChoice, DelegationRole } from './delegation.ts';
import { phaseSchema, type Snapshot, type Phase, type Action, type ReadinessStep, type Suggestions } from './model.ts';
import { readinessComplete, nextReadinessStep, readinessHelp, type SkippableStepId } from './readiness.ts';
import { parseReplyGate } from './gate.ts';
import { checkHelp, rowActions, supplementaryChecks, toolHelp } from './check-actions.ts';
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
const checkLabels = { notrun: 'Не запускалась', 'reported-pass': 'PASS в отчёте', warn: 'С замечаниями', fail: 'Ошибка', unknown: 'Не подтверждено' };

/** Info mark: "?" in a circle, drawn inline so it never falls back to a host glyph. */
const InfoIcon = () => <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
  <circle cx="8" cy="8" r="6.75" /><path d="M6.2 6.1a1.9 1.9 0 0 1 3.7.6c0 1.3-1.9 1.6-1.9 2.8" /><circle cx="8" cy="11.6" r="0.4" fill="currentColor" />
</svg>;

/** Superscript «?» that toggles a plain-language description below its row. */
const HelpMark = ({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) =>
  <button type="button" className="ml-0.5 inline-flex -translate-y-1.5 cursor-pointer rounded-full border-0 bg-transparent p-0.5 align-top text-muted-foreground hover:text-foreground"
    aria-label={label} aria-expanded={open} onClick={onToggle}><InfoIcon /></button>;

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
  const [help, setHelp] = useState<string | null>(null);
  const [network, setNetwork] = useState(false);
  const [view, setViewState] = useState<'nav' | 'settings'>(() => {
    if (!delegation) return 'nav';
    try { return window.sessionStorage.getItem(`aif-view:${threadId}`) === 'settings' ? 'settings' : 'nav'; } catch { return 'nav'; }
  });
  const setView = (v: 'nav' | 'settings') => {
    setViewState(v);
    try { window.sessionStorage.setItem(`aif-view:${threadId}`, v); } catch {}
  };
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
  const setReadinessSkip = async (stepId: SkippableStepId, skipped: boolean) => {
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
  const settingsAttention = !!snapshot && (snapshot.profile === 'invalid' ||
    snapshot.actions.some(a => a.group === 'maintenance' && a.available && updateInVersionDetails(snapshot, a.id)));
  const versionsLine = snapshot && <div className="aif-versions flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
    <span>CLI <b className="font-semibold text-foreground">{snapshot.versions.globalCli ?? 'не найден'}</b></span>
    <span>Проект <b className="font-semibold text-foreground">{snapshot.versions.installed ?? 'не указан'}</b></span>
    {snapshot.versions.sourceVersion && <span>Git <b className="font-semibold text-foreground">{snapshot.versions.sourceVersion}</b> @{snapshot.versions.sourceSha?.slice(0, 7)}{snapshot.versions.sourceDirty ? ' · изменён' : ''}</span>}
    {snapshot.extensions.map(e => <span key={e.name} title={e.installedVersion ? 'Установленная версия расширения' : 'Записанная версия; установленные файлы не подтверждены'}>{e.name} <b className="font-semibold text-foreground">{e.installedVersion ?? e.recordedVersion ?? 'неизвестна'}</b>{!e.installedVersion && ' · не подтверждена'}</span>)}
  </div>;
  return <section aria-label="AI Factory workflow" className={cn('aif-card flex min-w-0 flex-col gap-4 text-sm text-foreground [overflow-wrap:anywhere]',
    compact ? '' : 'my-3 rounded-xl border border-border bg-card p-4')}>
    <header className={cn('flex min-h-8 items-center gap-2', delegation && 'sticky -top-4 z-10 -mx-4 -mt-4 border-b border-border bg-background/90 px-4 py-3 backdrop-blur')}>
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><Icon name="Workflow" className="size-3.5" /></span>
      <strong className="text-base font-semibold tracking-tight whitespace-nowrap">AI Factory</strong>
      {snapshot && snapshot.profile !== 'upstream' && <Badge variant="secondary" className="min-w-0 truncate font-medium">{profileNames[snapshot.profile]}</Badge>}
      <span className="ml-auto flex items-center gap-2">
        {delegation && <div role="tablist" aria-label="Раздел панели" className="flex gap-0.5 rounded-lg bg-muted p-0.5">
          {(['nav', 'settings'] as const).map(v => <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
            className={cn('h-7 cursor-pointer rounded-md px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
              view === v ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}>
            {v === 'nav' ? 'Навигация' : 'Настройки'}{v === 'settings' && settingsAttention && <><span aria-hidden="true" className="ml-1 inline-block size-1.5 rounded-full bg-primary" /><span className="sr-only">, есть что проверить</span></>}
          </button>)}
        </div>}
        <Hint text="Перечитать задачи и проверки; версии CLI/Git и GitHub кэшируются на сутки"><Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => void refresh(false, true)}
          aria-label="Обновить статус AI Factory"><Icon name="RotateCcw" className="size-4" /></Button></Hint>
      </span>
    </header>
    {loading && <div role="status" aria-label="Читаю локальный статус…" className="h-24 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />}
    {error && <Callout tone="error" role="alert">{error}</Callout>}
    {notice && <Callout role="status">{notice}</Callout>}
    {snapshot && <>
      {!delegation && versionsLine}

      {delegation && view === 'nav' && snapshot.readiness.length > 0 && !readinessComplete(snapshot.readiness) &&
        <ReadinessSection snapshot={snapshot} run={run} busy={busy} sending={sending} setReadinessSkip={setReadinessSkip} />}

      {(!delegation || view === 'nav') && <Section label="Текущий этап" title="Сейчас">
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
      </Section>}

      {delegation && view === 'nav' && snapshot.configured && <WorkingSection threadId={threadId} />}

      {(!delegation || view === 'nav') && snapshot.target && snapshot.checks.length > 0 && <Disclosure className="aif-checks" summary={<>Что проверить <span className="font-normal text-muted-foreground">· из чата: {snapshot.checks.filter(c => c.chat).length} · отчётов PASS: {snapshot.checks.filter(c => c.state === 'reported-pass').length}</span></>}>
        <p className="m-0 text-xs text-muted-foreground">Дополнительные проверки — по выбору. Правила проекта и обязательные gates могут требовать их перед завершением; блокирующий FAIL сохраняет силу. Галочки задач и результаты проверок независимы. Актуальность отчётов подтверждает владелец workflow.</p>
        <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-lg border border-border p-0">{snapshot.checks.map(c => <li key={c.id} className="flex flex-col gap-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="font-medium">{c.label}{checkHelp[c.id] && <HelpMark label={`Что проверяет «${c.label}»`} open={help === c.id} onToggle={() => setHelp(help === c.id ? null : c.id)} />}</strong>
            {c.required ? <span className="text-xs text-muted-foreground">нужно для завершения</span> : supplementaryChecks.has(c.id) && <span className="text-xs text-muted-foreground" title="Дополнительный шаг flow; действующие правила проекта сохраняют приоритет">по выбору</span>}
            <Badge variant={checkTone(c)} className="ml-auto" title={c.detail}>{c.chat ? `${c.chat.result.status.toUpperCase()} · из чата` : checkLabels[c.state]}</Badge>
          </div>
          {help === c.id && <p className="m-0 rounded-md bg-muted px-3 py-2 text-xs">{checkHelp[c.id]}</p>}
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
        {!delegation && <Disclosure summary="Настройка инструментов">{renderActions(snapshot.actions.filter(a => a.group === 'setup' && (a.id === 'quality-setup' || a.id === 'ci-setup')))}</Disclosure>}
      </Disclosure>}

      {delegation && view === 'settings' && <>
        {snapshot.configured && <DelegationSection threadId={threadId} environmentId={environmentId} busy={busy} />}
        {snapshot.readiness.length > 0 && <ReadinessSection snapshot={snapshot} run={run} busy={busy} sending={sending} setReadinessSkip={setReadinessSkip} />}
        <Disclosure summary="Настройка инструментов">{renderActions(snapshot.actions.filter(a => a.group === 'setup' && (a.id === 'quality-setup' || a.id === 'ci-setup')))}</Disclosure>
        <ToolsSection actions={snapshot.actions.filter(a => a.group === 'setup' && toolHelp[a.id])} renderAction={renderAction} />
      </>}

      {(!delegation || view === 'settings') && <Disclosure className="aif-details" summary={<>Версии и расширения{snapshot.extensions.length ? <span className="font-normal text-muted-foreground"> · {snapshot.extensions.length}</span> : null}</>}>
        {delegation && versionsLine}
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
      </Disclosure>}
      {snapshot.diagnostics.length > 0 && <Disclosure summary={`Примечания · ${snapshot.diagnostics.length}`}>
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-xs text-muted-foreground">{snapshot.diagnostics.map((d, i) => <li key={i}>{d}</li>)}</ul>
      </Disclosure>}
      <footer className="border-t border-border pt-3 text-xs text-muted-foreground">{snapshot.cache?.source === 'saved' ? 'Сохранённые данные' : snapshot.cache?.source === 'memory' ? 'Данные из кэша' : 'Локальный статус'} · {new Date(snapshot.collectedAt).toLocaleTimeString()}
        {snapshot.cache?.refreshing && ' · обновляются в фоне…'}{snapshot.cache?.refreshError && ' · обновление не удалось; нажмите обновить для повторного чтения'} · {busy ? 'действия доступны после завершения работы' : 'кнопки отправляют выбранную команду в этот чат'}</footer>
    </>}
  </section>;
}

const childStatus: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'в очереди', tone: 'idle' }, starting: { label: 'запускается', tone: 'live' }, active: { label: 'работает', tone: 'live' },
  stopping: { label: 'останавливается', tone: 'live' }, idle: { label: 'готово', tone: 'done' }, error: { label: 'ошибка', tone: 'error' },
};
const toPicker = (c: Extract<DelegationChoice, { mode: 'bb' }>): PickerValue =>
  ({ providerId: c.providerId, model: c.model, reasoningLevel: (c.reasoning ?? 'medium') as PickerValue['reasoningLevel'], ...(c.tier ? { serviceTier: c.tier as PickerValue['serviceTier'] } : {}) });
const fromPicker = (v: PickerValue): DelegationChoice =>
  ({ mode: 'bb', providerId: v.providerId, model: v.model, ...(v.reasoningLevel ? { reasoning: v.reasoningLevel } : {}), ...(v.serviceTier && v.serviceTier !== 'default' ? { tier: v.serviceTier } : {}) });
// Starting point for the picker; it immediately reconciles to a real model from the live catalog.
const pickerSeed: PickerValue = { providerId: 'codex', model: '', reasoningLevel: 'high' as PickerValue['reasoningLevel'] };

const roleText = {
  implement: { title: 'Код', skills: '/aif-implement', group: 'Кто пишет код',
    saved: '/aif-implement будет передавать задачи выбранной модели.', self: 'Код снова пишет агент этого чата.',
    note: 'Хранится в .ai-factory.json → phases.implement. /aif-implement отдаёт каждую задачу дочернему треду на этой модели, затем сам проверяет diff и отмечает задачу в плане.' },
  research: { title: 'Разведчик 1', skills: '/aif-plan, /aif-fix, /aif-qa', group: 'Кто исследует код',
    saved: 'Разведчики AI Factory будут запускаться дочерними тредами на выбранной модели.', self: 'Разведку снова делают встроенные помощники агента.',
    note: 'Разведчик 1 — архитектура и затронутые модули; если навык просит одного разведчика, это он. Хранится в .ai-factory/skill-context/global-skill-context.md. Разведчики идут дочерними тредами параллельно, агент собирает их отчёты.' },
  research2: { title: 'Разведчик 2', skills: 'шаблоны и соглашения', group: 'Кто ищет шаблоны',
    saved: 'Разведчик 2 будет работать на выбранной модели.', self: 'Разведчик 2 снова работает как разведчик 1.',
    selfLabel: 'Как разведчик 1', selfBadge: 'как разведчик 1', note: '' },
  research3: { title: 'Разведчик 3', skills: 'зависимости и связи', group: 'Кто ищет связи',
    saved: 'Разведчик 3 будет работать на выбранной модели.', self: 'Разведчик 3 снова работает как разведчик 1.',
    selfLabel: 'Как разведчик 1', selfBadge: 'как разведчик 1', note: 'Разведчик 3 берёт и всех следующих, если навык просит больше трёх.' },
} as const satisfies Record<DelegationRole, { title: string; skills: string; group: string; saved: string; self: string; note: string; selfLabel?: string; selfBadge?: string }>;

/** One-line role row; the «Этот агент / Другая модель» editor opens on «Изменить» and saves through setDelegation. */
function ModelChoice({ role, saved, providerName, environmentId, busy, locked: lockedOuter, onSave }: {
  role: DelegationRole; saved: DelegationChoice; providerName: (id: string | null) => string | null; environmentId: string | null; busy: boolean; locked: boolean;
  onSave: (choice: DelegationChoice) => Promise<void>;
}) {
  const text: { title: string; skills: string; group: string; saved: string; self: string; note: string; selfLabel?: string; selfBadge?: string } = roleText[role];
  const [editing, setEditing] = useState(false);
  const [help, setHelp] = useState(false);
  const [mode, setMode] = useState<'self' | 'bb'>(saved.mode);
  const [pick, setPick] = useState<PickerValue | null>(saved.mode === 'bb' ? toPicker(saved) : null);
  const [saving, setSaving] = useState(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => { setMode(saved.mode); setPick(saved.mode === 'bb' ? toPicker(saved) : null); }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const choice: DelegationChoice | null = mode === 'self' ? { mode: 'self' } : pick?.model ? fromPicker(pick) : null;
  const dirty = !!choice && JSON.stringify(choice) !== savedKey;
  const locked = saving || lockedOuter;
  const savedLabel = saved.mode === 'bb' ? [providerName(saved.providerId), saved.model, saved.reasoning].filter(Boolean).join(' · ') : text.selfBadge ?? 'агент этого чата';
  async function save() {
    if (!choice) return;
    setSaving(true);
    try { await onSave(choice); toast.success(choice.mode === 'bb' ? text.saved : text.self); setEditing(false); }
    finally { setSaving(false); }
  }
  function cancel() {
    setMode(saved.mode); setPick(saved.mode === 'bb' ? toPicker(saved) : null); setEditing(false);
  }
  return <div className="flex min-w-0 flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
    <div className="flex min-w-0 items-center gap-2">
      <h4 className="m-0 shrink-0 text-sm font-medium">{text.title}{text.note && <HelpMark label={`Подробнее: ${text.title}`} open={help} onToggle={() => setHelp(!help)} />}</h4>
      <span className="truncate text-xs text-muted-foreground max-sm:hidden">{text.skills}</span>
      <Badge variant="secondary" className="ml-auto min-w-0 max-w-[55%] truncate font-medium">{savedLabel}</Badge>
      {!editing && <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-xs" aria-label={`Изменить: ${text.title}`} disabled={locked} onClick={() => setEditing(true)}>Изменить</Button>}
    </div>
    {help && text.note && <p className="m-0 text-xs text-muted-foreground">{text.note}</p>}
    {editing && <>
      <div role="radiogroup" aria-label={text.group} className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5">
        {(['self', 'bb'] as const).map(m => <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={locked}
          onClick={() => { setMode(m); if (m === 'bb' && !pick) setPick(pickerSeed); }}
          className={cn('h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
            mode === m ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')}>{m === 'self' ? text.selfLabel ?? 'Этот агент' : 'Другая модель'}</button>)}
      </div>
      {mode === 'bb' && pick && <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs text-muted-foreground">Провайдер и модель</span>
        <ProviderModelPicker value={pick} onChange={setPick} disabled={locked} align="start"
          routing={environmentId ? { kind: 'environment', environmentId } : undefined} className="max-w-full" />
      </div>}
      <div className="flex flex-wrap gap-2">
        <Hint text={busy ? 'Дождитесь, пока агент закончит текущую работу' : 'Сохранить выбор в проекте'}><Button type="button" size="sm" disabled={locked || busy || !dirty} onClick={() => void save()}>{saving ? 'Сохраняю…' : 'Сохранить'}</Button></Hint>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={cancel}>Отменить</Button>
      </div>
    </>}
  </div>;
}

function useDelegationView(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<DelegationView | null>(null);
  const [error, setError] = useState('');
  const [applied, setApplied] = useState<string | null>(null);
  const appliedRef = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const next = await rpc.call('delegation', { threadId });
      if (mounted.current) {
        setView(next); setError('');
        if (next.appliedDefaults && appliedRef.current !== next.appliedDefaults) {
          appliedRef.current = next.appliedDefaults;
          setApplied(next.appliedDefaults);
          toast.success(next.appliedDefaults);
        }
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
  }, [rpc, threadId]);
  useEffect(() => { void load(); }, [load]);
  useRealtime('changed', (payload: unknown) => { if ((payload as { threadId?: string })?.threadId === threadId) void load(); });
  return { view, setView, error, setError, load, applied };
}

function DelegationSection({ threadId, environmentId, busy }: { threadId: string; environmentId: string | null; busy: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const { view, setView, error, setError, applied } = useDelegationView(threadId);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!view) return <Section label="Исполнители" title="Исполнители">
    {error ? <p className="m-0 text-xs text-muted-foreground">Настройка недоступна: {error}</p> : <div className="h-20 animate-pulse rounded-md bg-muted motion-reduce:animate-none" aria-hidden="true" />}
  </Section>;
  const providerName = (id: string | null) => view.providers.find(p => p.id === id)?.name ?? id;
  const save = (role: DelegationRole) => async (choice: DelegationChoice) => {
    setError('');
    try {
      const next = await rpc.call('setDelegation', { threadId, choice, role });
      if (mounted.current) setView(next);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); throw e; }
  };
  const changeDefaults = async (action: 'from-project' | 'apply' | 'clear') => {
    setError('');
    try {
      const next = await rpc.call('setDelegationDefaults', { threadId, action });
      if (mounted.current) setView(next);
      toast.success(action === 'from-project' ? 'Умолчания взяты из этого проекта' : action === 'apply' ? 'Умолчания применены к этому проекту' : 'Умолчания очищены');
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
  };
  return <Section label="Исполнители" title="Исполнители">
    {applied && <Callout role="status">{applied}</Callout>}
    {view.foreign && <Callout>phases.implement в .ai-factory.json настроен на агента «{view.foreign}». Панель его не меняет.</Callout>}
    {view.error && <Callout tone="error">{view.error}</Callout>}
    <div className="flex min-w-0 flex-col divide-y divide-border">
      <ModelChoice role="implement" saved={view.choice} providerName={providerName} environmentId={environmentId} busy={busy} locked={!!view.foreign} onSave={save('implement')} />
      <ModelChoice role="research" saved={view.research} providerName={providerName} environmentId={environmentId} busy={busy} locked={false} onSave={save('research')} />
      <ModelChoice role="research2" saved={view.research2} providerName={providerName} environmentId={environmentId} busy={busy} locked={false} onSave={save('research2')} />
      <ModelChoice role="research3" saved={view.research3} providerName={providerName} environmentId={environmentId} busy={busy} locked={false} onSave={save('research3')} />
    </div>
    <DefaultsSection view={view} busy={busy} onChange={changeDefaults} />
    {error && <Callout tone="error" role="status">{error}</Callout>}
  </Section>;
}

type DefaultsAction = 'from-project' | 'apply' | 'clear';

/** Plugin-wide default executor models for new AI Factory projects; the owner picks them from a real project's settings. */
function DefaultsSection({ view, busy, onChange }: { view: DelegationView; busy: boolean; onChange: (action: DefaultsAction) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const providerName = (id: string | null) => view.providers.find(p => p.id === id)?.name ?? id;
  const label = (role: DelegationRole) => {
    const choice = view.defaults?.[role];
    if (!choice) return '';
    return choice.mode === 'bb' ? [providerName(choice.providerId), choice.model, choice.reasoning].filter(Boolean).join(' · ') : (roleText[role] as { selfBadge?: string }).selfBadge ?? 'агент этого чата';
  };
  async function act(action: DefaultsAction) {
    if (pending || busy) return;
    setPending(true);
    try { await onChange(action); } finally { setPending(false); }
  }
  return <Disclosure summary={<>Модели по умолчанию для новых проектов <span className="font-normal text-muted-foreground"> · {view.defaults ? 'заданы' : 'не заданы'}</span></>}>
    <p className="m-0 text-xs text-muted-foreground">Применяются один раз в проекте с AI Factory, где у всех ролей «Этот агент». Дальше проект живёт своей настройкой.</p>
    {view.defaults && <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
      {(Object.keys(roleText) as DelegationRole[]).map(role => <li key={role}>{roleText[role].title} — {label(role)}</li>)}
    </ul>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={pending || busy} onClick={() => void act('from-project')}>Взять из этого проекта</Button>
      <Button type="button" size="sm" variant="outline" disabled={pending || busy || !view.defaults} onClick={() => void act('apply')}>Применить к этому проекту</Button>
      <Button type="button" size="sm" variant="outline" disabled={pending || busy || !view.defaults} onClick={() => void act('clear')}>Очистить</Button>
    </div>
  </Disclosure>;
}

function WorkingSection({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { view } = useDelegationView(threadId);
  if (!view || view.children.length === 0) return null;
  const providerName = (id: string | null) => view.providers.find(p => p.id === id)?.name ?? id;
  return <Section label="В работе" title="В работе">
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
  </Section>;
}

/** Optional AI Factory commands that are not part of readiness: docs, roadmap, rules, build, docker, archive. */
function ToolsSection({ actions, renderAction }: { actions: Action[]; renderAction: (action: Action) => ReactNode }) {
  const [help, setHelp] = useState<string | null>(null);
  if (!actions.length) return null;
  return <Disclosure className="aif-tools" summary="Другие команды">
    <p className="m-0 text-xs text-muted-foreground">По необходимости, в любом порядке. Кнопка отправляет команду в этот чат.</p>
    <ul className="m-0 flex list-none flex-col gap-2 p-0">{actions.map(a => <li key={a.id} className="flex flex-col gap-1">
      <span className="flex items-center">{renderAction(a)}<HelpMark label={`Что делает «${a.label}»`} open={help === a.id} onToggle={() => setHelp(help === a.id ? null : a.id)} /></span>
      {help === a.id && <p className="m-0 rounded-md bg-muted px-3 py-2 text-xs">{toolHelp[a.id]}</p>}
    </li>)}</ul>
  </Disclosure>;
}

function ReadinessSection({ snapshot, run, busy, sending, setReadinessSkip }: {
  snapshot: Snapshot; run: (action: Action) => void; busy: boolean; sending: boolean;
  setReadinessSkip: (stepId: SkippableStepId, skipped: boolean) => Promise<void>;
}) {
  const [pendingSkip, setPendingSkip] = useState<string | null>(null);
  const [help, setHelp] = useState<string | null>(null);
  const steps = snapshot.readiness;
  const next = nextReadinessStep(steps);
  const actionFor = (s: ReadinessStep) => snapshot.actions.find(a => a.id === s.actionId);
  const iconFor = (s: ReadinessStep) => s.state === 'done' ? 'CircleCheck' : s.state === 'skipped' ? 'CircleDashed' : 'Circle';
  const stateLabel = (s: ReadinessStep) => s.state === 'done' ? 'Выполнен' : s.state === 'skipped' ? 'Пропущен' : 'Ожидает очереди';
  async function toggleSkip(s: ReadinessStep, skipped: boolean) {
    if (pendingSkip) return;
    setPendingSkip(s.id);
    try { await setReadinessSkip(s.id as SkippableStepId, skipped); }
    finally { setPendingSkip(null); }
  }
  function stepRow(s: ReadinessStep, n: number, isNext: boolean) {
    const action = s.state === 'todo' ? actionFor(s) : undefined;
    const small = 'h-7 px-2.5 text-xs';
    const skip = s.state === 'skipped'
      ? <Button type="button" size="sm" variant="ghost" className={cn(small, 'text-muted-foreground')} disabled={pendingSkip !== null} onClick={() => void toggleSkip(s, false)}>Вернуть</Button>
      : s.skippable && s.state === 'todo'
        ? <Button type="button" size="sm" variant="ghost" className={cn(small, 'text-muted-foreground')} disabled={pendingSkip !== null} onClick={() => void toggleSkip(s, true)}>Пропустить</Button>
        : null;
    return <li key={s.id} className="flex flex-col gap-1">
      <div className="flex min-h-7 items-center gap-2">
        <Icon name={iconFor(s)} aria-label={stateLabel(s)} className={cn('size-4 shrink-0', s.state === 'done' ? 'text-primary' : 'text-muted-foreground')} />
        <span className={cn('min-w-0 flex-1 text-sm', s.state === 'todo' ? 'font-medium' : 'text-muted-foreground')}>
          <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{n}.</span>{s.label}{readinessHelp[s.id] && <HelpMark label={`Что делает шаг «${s.label}»`} open={help === s.id} onToggle={() => setHelp(help === s.id ? null : s.id)} />}
        </span>
        {(action || skip) && <span className="flex shrink-0 items-center gap-1">
          {action && <Hint text={`${action.reason}\n${action.command}`}><Button type="button" size="sm" variant={isNext ? 'default' : 'outline'} className={small}
            aria-label={`Запустить: ${s.label}`} disabled={sending || busy || !action.available} onClick={() => void run(action)}>
            Запустить{!action.available && (action.disabledReason === 'unchanged' ? ' · без изменений' : ' · не установлен')}</Button></Hint>}
          {skip}
        </span>}
      </div>
      {help === s.id && <div className="ml-6 rounded-md bg-muted px-3 py-2 text-xs">
        <p className="m-0">{readinessHelp[s.id]}</p>
        {s.state === 'todo' && s.missing.length > 0 && !s.anyOf && <p className="m-0 mt-1 break-words text-muted-foreground">Не найдено: {s.missing.join(', ')}</p>}
      </div>}
    </li>;
  }
  const numbered = steps.map((s, i) => ({ s, n: i + 1 }));
  const rows = (items: typeof numbered) => <ol className="m-0 flex list-none flex-col gap-1 p-0">{items.map(({ s, n }) => stepRow(s, n, next?.id === s.id))}</ol>;
  if (readinessComplete(steps)) return <Disclosure summary="Проект готов к работе через AI Factory">{rows(numbered)}</Disclosure>;
  const finished = numbered.filter(({ s }) => s.state !== 'todo');
  const doneCount = finished.filter(({ s }) => s.state === 'done').length, skippedCount = finished.length - doneCount;
  return <Section label="Подготовка проекта" title="Подготовка проекта">
    <p className="m-0 text-xs text-muted-foreground">Выполните шаги по порядку, чтобы AI Factory работал полностью</p>
    {finished.length > 0 && <Disclosure className="aif-readiness-finished" summary={<span className="text-sm font-normal text-muted-foreground">
      Выполнено · {doneCount}{skippedCount ? ` · пропущено · ${skippedCount}` : ''}</span>}>{rows(finished)}</Disclosure>}
    {rows(numbered.filter(({ s }) => s.state === 'todo'))}
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
        <p className="aif-muted aif-small">Заявленный результат из чата. Актуальность отчёта для текущих файлов проверяет владелец workflow.</p>
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
