import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { definePluginApp, useRpc, useRealtime, useComposer, Markdown, experimental_Icon as Icon, experimental_FileLink as FileLink, type PluginMessageDirectiveProps, type ExperimentalThreadContextCardProps, type ExperimentalThreadTabProps, type ExperimentalCodeFenceRendererProps } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';
import { phaseSchema, cardIdSchema, RESEARCH_TASK_MAX_LENGTH, type Snapshot, type Phase, type Action, type Suggestions } from './model.ts';
import { sessionBriefBlocked } from './session-brief.ts';
import { parseReplyGate } from './gate.ts';
import { checkHelp, rowActions, supplementaryChecks } from './check-actions.ts';
import { updateInVersionDetails, VERSION_TTL } from './versions.ts';
import { contextSetupInDetails } from './workflow.ts';
import { isBasicPlanPath, usesBasicWorkflow, isCompletedPlan } from './basic-workflow.ts';
import './aif-chat.css';
import { mountPlanPresentation } from './plan-presentation.ts';
import { preparationCommands, preparationHelp } from './project-preparation.ts';

const phaseNames: Record<Phase, string> = { unknown: 'Контекст задачи', explore: 'Исследование', plan: 'Планирование', improve: 'Уточнение плана', implement: 'Выполнение плана', verify: 'Проверка', fix: 'Исправление замечаний', done: 'Финализация' };
const profileNames: Record<Snapshot['profile'], string> = { none: 'Нет установки', upstream: 'AI Factory', 'aifhub-classic': 'AIFHub · classic', 'aifhub-openspec': 'AIFHub · OpenSpec', 'aifhub-ultra': 'AIFHub · legacy ultra', invalid: 'Проверьте конфигурацию' };
const checkLabels = { notrun: 'Нет отчёта', 'reported-pass': 'PASS в отчёте', warn: 'С замечаниями', fail: 'Ошибка', unknown: 'Не подтверждено' };
const checkIcons = { notrun: 'Minus', 'reported-pass': 'CircleCheck', warn: 'AlertTriangle', fail: 'CircleX', unknown: 'CircleQuestion' };

const actionIcons: Record<string, string> = {
  commit: 'GitBranch', fix: 'ToolCase', 'fix-new': 'ToolCase', 'fix-findings': 'ToolCase', 'execute-fix': 'ToolCase',
  verify: 'CircleCheck', 'check-verify': 'ListTodo', implement: 'Play', 'implement-proposed': 'Play',
  explore: 'Search', plan: 'ListTodo', improve: 'Edit', 'apply-improvements': 'Check',
  done: 'Archive', 'ultra-receipt': 'FileText', sync: 'FolderSync', 'context-sync': 'FolderSync', 'rules-sync': 'FolderSync',
  'context-compile': 'FileText', 'setup-context': 'Settings', analyze: 'Search', init: 'Download',
  install: 'Download', 'install-factory': 'Download', 'update-factory': 'PackageReceive', 'update-extensions': 'Puzzle',
  'check-rules': 'FileText', 'rules-check': 'FileText', 'check-security': 'SecurityCheck', 'security-checklist': 'SecurityCheck',
  'check-review': 'GitPullRequest', review: 'GitPullRequest', 'check-mode': 'Settings', mode: 'Settings',
  'check-worktree': 'FolderGit', 'check-coupling': 'Workflow', 'qa-prepare': 'ListView', qa: 'ListView',
  'qa-run': 'ListTodo', 'qa-check': 'ListTodo', quality: 'CircleCheck', 'quality-setup': 'Settings',
  ci: 'Workflow', 'ci-setup': 'Settings',
};
function ActionIcon({ id, command = '' }: { id: string; command?: string }) {
  const skill = command.match(/(?:^|[\s$/])aif-([a-z][a-z0-9-]*)\b/)?.[1];
  if (id.startsWith('prep-')) return <Icon name={preparationCommands[id.slice(5)]?.icon ?? 'Settings'} className="aif-button-icon" aria-hidden="true" />;
  return <Icon name={actionIcons[id.replace(/^basic-/, '')] ?? actionIcons[skill ?? ''] ?? 'ArrowRight'} className="aif-button-icon" aria-hidden="true" />;
}

function ExplainedLabel({ label, help, prefix, detail }: { label: string; help?: string; prefix?: ReactNode; detail?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="aif-explained-label">
    <span className="aif-help-heading">
      {prefix}<strong>{label}</strong>
      {help && <button type="button" className="aif-help-toggle" aria-label={`Подробнее: ${label}`}
        aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <span aria-hidden="true">?</span>
      </button>}
    </span>
    {help && <div className="aif-help-text" id={id} hidden={!open}>{help}{detail}</div>}
  </div>;
}

function CheckPanel({ checks, actions, renderAction, openReport }: {
  checks: Snapshot['checks']; actions: Action[]; renderAction: (action: Action) => ReactNode; openReport?: (path: string) => void;
}) {
  const blocking = checks.filter(check => check.chat?.result.blocking).length;
  const fromChat = checks.filter(check => check.chat).length;
  const filePasses = checks.filter(check => check.state === 'reported-pass').length;
  const setup = actions.filter(action => action.group === 'setup' && !action.id.startsWith('prep-'));
  const orderedChecks = [...checks].sort((a, b) => Number(!!b.chat?.result.blocking) - Number(!!a.chat?.result.blocking) || Number(b.required) - Number(a.required));

  return <details className="aif-checks aif-disclosure" open={blocking > 0 || undefined}>
    <summary>
      <span className="aif-check-summary">
        <span>Что проверить</span>
        {blocking > 0 && <span className="aif-check-state" data-state="fail">Блокирующие · {blocking}</span>}
        {fromChat > 0 && <span className="aif-check-summary-count">Из чата · {fromChat}</span>}
        {filePasses > 0 && <span className="aif-check-summary-count">PASS в отчётах · {filePasses}</span>}
      </span>
    </summary>
    <div className="aif-disclosure-body">
      <ul className="aif-check-list">
        {orderedChecks.map(check => {
          const { chat } = check;
          const state = chat ? chat.result.status === 'pass' ? 'reported-pass' : chat.result.status : check.state;
          const label = chat ? `${chat.result.status.toUpperCase()} · из чата` : checkLabels[state];
          const action = actions.find(item => item.id === rowActions[check.id]);
          const reportPath = check.path;
          const hasDetails = chat || reportPath || (check.state !== 'notrun' && check.detail);

          return <li key={check.id} className="aif-check-row" data-blocking={chat?.result.blocking || undefined}>
            <div className="aif-check-head">
              <div className="aif-check-label">
                <ExplainedLabel label={check.label} help={checkHelp[check.id]} />
                {check.required ? <small className="aif-check-required" title="Нужно для завершения">Обязательно</small>
                  : supplementaryChecks.has(check.id) && <small className="aif-check-optional">по выбору</small>}
              </div>
              <div className="aif-check-controls">
                <span className="aif-check-state" data-state={state}>
                  <Icon name={checkIcons[state]} aria-hidden="true" />{label}
                </span>
                {action && renderAction(action)}
                {reportPath && openReport && <button type="button" className="aif-action aif-secondary" onClick={() => openReport(reportPath)}>
                  <Icon name="FileText" className="aif-button-icon" aria-hidden="true" />Отчёт
                </button>}
              </div>
            </div>
            {chat && (chat.result.blocking || chat.result.blockers.length > 0) && <div className="aif-check-findings">
              {chat.result.blocking && <strong>Блокирует следующий этап</strong>}
              {chat.result.blockers.length > 0 && <ul>{chat.result.blockers.map(item =>
                <li key={item.id}><strong>{item.id}</strong> {item.summary}{item.file && <> <code>{item.file}</code></>}</li>,
              )}</ul>}
            </div>}
            {hasDetails && <details className="aif-check-report">
              <summary aria-label={`Детали проверки «${check.label}»`}>Детали</summary>
              {chat && <>
                <p><time dateTime={chat.at}>{new Date(chat.at).toLocaleString('ru')}</time> · сообщение #{chat.seq}</p>
                <p>{chat.freshness === 'unchanged' ? 'Файлы не изменились. Повторная проверка заблокирована.'
                  : chat.freshness === 'changed' ? 'Файлы изменились после фиксации результата. Можно проверить повторно.'
                  : 'Актуальность для текущих файлов не подтверждена.'}</p>
                {chat.result.suggested_next?.reason && <p>{chat.result.suggested_next.reason}</p>}
              </>}
              <p>{chat ? `Файловый отчёт: ${reportPath ? checkLabels[check.state] + '. ' + check.detail : 'не найден.'}` : check.detail}</p>
            </details>}
          </li>;
        })}
      </ul>
      {setup.length > 0 && <details className="aif-setup">
        <summary>Настройка инструментов</summary>
        <div className="aif-actions">{setup.map(renderAction)}</div>
      </details>}
    </div>
  </details>;
}

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

function PlanDocument({ code, status, message }: ExperimentalCodeFenceRendererProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [saved, setSaved] = useState<{ path: string; seq: number; hash: string; environmentId: string } | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    if (status !== 'closed' || !code.trim()) { setSaved(null); return; }
    try {
      const value = await rpc.call('planDocument', { threadId: message.threadId, text: code.trim() });
      if (generation.current === id) { setSaved(value); setError(''); }
    } catch (e) { if (generation.current === id) { setSaved(null); setError(e instanceof Error ? e.message : String(e)); } }
  }, [rpc, message.threadId, code, status]);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  useRealtime('changed', (payload: unknown) => { if ((payload as { threadId?: string })?.threadId === message.threadId) void refresh(); });
  return <section className="aif-plan-document" data-aif-plan-document="true" aria-label="Документ плана">
    <header className="aif-plan-heading"><strong>План реализации</strong><span className="aif-profile">{status === 'streaming' ? 'Генерируется' : status === 'unclosed' ? 'Не завершён' : saved ? 'Сохранён' : 'Ожидает сохранения'}</span></header>
    <Markdown content={code} className="aif-plan-markdown" />
    {saved && <p className="aif-plan-file"><FileLink target={{ kind: 'workspace', environmentId: saved.environmentId, path: saved.path }}>Открыть файл плана</FileLink><small>{saved.path}</small></p>}
    {status === 'unclosed' && <p className="aif-error">Генерация прервана. Неполный план не сохранён и не запускается.</p>}
    {error && <div><p className="aif-error" role="alert">Не удалось сохранить план: {error}</p><button type="button" className="aif-action aif-secondary" onClick={() => void refresh()}><ActionIcon id="verify" />Повторить сохранение</button></div>}
    {status === 'closed' && !saved && !error && <p className="aif-muted aif-small">Действия появятся после завершения генерации и сохранения файла.</p>}
    {saved && <div className="aif-plan-controls" aria-label="Действия после плана"><WorkflowCard key={`${message.threadId}:${saved.path}`} threadId={message.threadId} initialTarget={saved.path} phase="plan" compact /></div>}
  </section>;
}

function WorkflowCard({ threadId, initialTarget = '', phase = 'unknown', openFile, compact = false, inline = false }: {
  threadId: string; initialTarget?: string; phase?: Phase; openFile?: ((path: string) => boolean) | null; compact?: boolean; inline?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [target, setTarget] = useState(initialTarget);
  const [newTask, setNewTask] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [network, setNetwork] = useState(false);
  const [savingPreparation, setSavingPreparation] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchTask, setResearchTask] = useState('');
  const [researchError, setResearchError] = useState('');
  const sequence = useRef(0);
  const mounted = useRef(true);
  const sendingRef = useRef(false);
  const preparationId = useId();
  const updatesId = useId();
  const updatesDetails = useRef<HTMLDetailsElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => { setTarget(initialTarget); setNewTask(false); setShowCompleted(false); setSnapshot(null); setResearchOpen(false); setResearchTask(''); setResearchError(''); }, [initialTarget, threadId]);
  const refresh = useCallback(async (checkUpdates = false, force = false) => {
    const id = ++sequence.current;
    try {
      const value = await rpc.call('status', { threadId, target: newTask ? '' : target, phase: newTask ? 'unknown' : phase,
        ...(newTask ? { newTask: true } : {}), checkUpdates, force });
      if (mounted.current && id === sequence.current) {
        setSnapshot(value); setError('');
        if (value.selectionReset) { setTarget(''); setNewTask(true); }
        if (value.configured && isBasicPlanPath(target)) setTarget('');
      }
    } catch (e) {
      if (mounted.current && id === sequence.current) { setError(e instanceof Error ? e.message : String(e)); setSnapshot(null); }
    } finally { if (mounted.current && id === sequence.current) setLoading(false); }
  }, [rpc, threadId, target, phase, newTask]);
  useEffect(() => {
    setLoading(true); void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    return () => window.clearInterval(interval);
  }, [refresh]);
  useRealtime('changed', (payload: unknown) => { if ((payload as { threadId?: string })?.threadId === threadId) void refresh(); });
  async function togglePreparation(visible: boolean) {
    setSavingPreparation(true);
    setError('');
    try {
      await rpc.call('setPreparationVisibility', { threadId, visible });
      if (mounted.current) await refresh();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setSavingPreparation(false);
    }
  }
  async function run(action: Action, task?: string) {
    if (!snapshot || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setError(''); setNotice('');
    if (action.id === 'basic-explore') setResearchError('');
    let stale = false;
    try {
      const result = await rpc.call('run', { threadId, target: snapshot.target?.path ?? target, phase: snapshot.phase,
        fingerprint: snapshot.fingerprint, actionId: action.id, requestId: crypto.randomUUID(), ...(newTask ? { newTask: true } : {}), ...(task === undefined ? {} : { researchTask: task }) });
      stale = result.stale === true;
      if (mounted.current) {
        setNotice(result.message);
        if (result.sent && action.id === 'basic-explore') { setResearchOpen(false); setResearchTask(''); }
        if (result.sent && result.newTask) { setTarget(''); setNewTask(true); setSnapshot(null); }
      }
    } catch (e) { if (mounted.current) {
      const message = e instanceof Error ? e.message : String(e);
      if (action.id === 'basic-explore') setResearchError(message); else setError(message);
    } }
    finally {
      if (stale && mounted.current) await refresh(false, true);
      sendingRef.current = false;
      if (mounted.current) {
        setSending(false);
        if (!stale) void refresh();
      }
    }
  }
  const busy = !!snapshot && (!['idle', 'error'].includes(snapshot.threadState) || !!snapshot.pendingQuestions || snapshot.pendingConfirmation !== false);
  const tasks = snapshot?.target?.tasks ?? [];
  const completed = tasks.filter(t => t.done).length;
  const hiddenPlans = snapshot?.candidates.filter(isCompletedPlan) ?? [];
  const visiblePlans = snapshot?.candidates.filter(candidate => showCompleted || !isCompletedPlan(candidate)) ?? [];
  const nextVersionCheck = snapshot?.upstream.checkedAt ? Date.parse(snapshot.upstream.checkedAt) + VERSION_TTL : 0;
  const researchAction = snapshot?.actions.find(a => a.id === 'basic-explore');
  const newResearch = researchAction && (snapshot?.target?.kind === 'basic' && tasks.length > 0 && completed === tasks.length
    || snapshot?.chatPlan?.accepted && snapshot.phase === 'done');
  const renderAction = (a: Action) => <button key={a.id} type="button"
    className={a.group === 'next' ? 'aif-action' : 'aif-action aif-secondary'} disabled={sending || busy || !a.available}
    title={`${a.reason}\n${a.command}`} onClick={() => {
      if (a.id === 'basic-explore') { setResearchOpen(true); setError(''); setNotice(''); }
      else void run(a);
    }}><ActionIcon id={a.id} command={a.command} /><span>{a.label}{!a.available && (a.disabledReason === 'unchanged' ? ' · без изменений' : a.disabledReason === 'requires-cli222' ? ' · нужен CLI 2.22+' : a.disabledReason === 'context-blocked' ? ' · контекст неактуален' : ' · не установлен')}</span></button>;
  const renderActions = (actions: Action[]) => <div className="aif-actions">{actions.map(renderAction)}</div>;
  const preparation = snapshot?.preparation;
  const hasPreparation = !!preparation?.length;
  const preparationVisible = snapshot?.preparationVisible === true;
  const updates = snapshot?.actions.filter(a => a.id === 'update-factory' || a.id === 'update-extensions') ?? [];
  const maintenance = snapshot?.actions.filter(a => a.group === 'maintenance' && !updates.includes(a) &&
    !contextSetupInDetails(snapshot, a.id) && (!hasPreparation || a.id !== 'setup-context' && a.id !== 'basic-install')) ?? [];
  const showUpdateIndicator = snapshot && updates.some(a => a.available && !updateInVersionDetails(snapshot, a.id));
  const required = preparation?.filter(step => !step.optional) ?? [];
  const optional = preparation?.filter(step => step.optional) ?? [];
  const nextSetupStep = required.find(step => step.state === 'missing')?.id;
  const renderSetupStep = (step: NonNullable<Snapshot['preparation']>[number], number?: number) => {
    const installed = step.id === 'install' && step.state === 'found';
    const actionId = step.id === 'install' ? installed ? 'update-factory' : 'basic-install'
      : step.id === 'describe' ? 'setup-context' : `prep-${step.id}`;
    const action = snapshot?.actions.find(item => item.id === actionId);
    const current = step.id === nextSetupStep;
    const showAction = !!action && (installed || step.optional || current || step.id === 'describe' && step.state === 'found');
    return <li key={step.id} className="aif-prep-step" data-state={step.state} aria-current={current ? 'step' : undefined}>
      <span className="aif-prep-mark" role="img" aria-label={step.state === 'found' ? 'Файлы найдены' : step.state === 'unknown' ? 'Не удалось проверить файлы' : 'Файлы не найдены'}>
        <Icon name={step.state === 'found' ? 'CircleCheck' : step.state === 'unknown' ? 'CircleQuestion' : 'Circle'} className="aif-button-icon" aria-hidden="true" />
      </span>
      <div>
        <ExplainedLabel label={installed ? 'AI Factory установлен' : step.label} help={preparationHelp[installed ? 'update' : step.id]}
          prefix={number !== undefined && <span className="aif-muted" aria-hidden="true">{number}.</span>}
          detail={<div className="aif-prep-paths">{step.paths.map(file => <code key={file}>{file}</code>)}</div>} />
        {showAction && <div className={current ? 'aif-prep-action aif-prep-current' : 'aif-prep-action'}>{renderAction(action)}</div>}
      </div>
    </li>;
  };
  const setupContent = preparation && <>
    <ol className="aif-prep-list">{required.map((step, index) => renderSetupStep(step, index + 1))}</ol>
    <details className="aif-prep-optional"><summary>Дополнительно</summary>
      <ul className="aif-prep-list">{optional.map(step => renderSetupStep(step))}</ul>
    </details>
  </>;
  if (inline && (loading && !snapshot || snapshot && (snapshot.pendingConfirmation || snapshot.pendingQuestions))) return null;
  return <section className={`aif-card${compact ? ' aif-compact' : ''}`} aria-label="AI Factory workflow">
    <header className="aif-heading"><span className="aif-brand-icon"><Icon name="Workflow" aria-hidden="true" /></span><strong>AI Factory</strong>
      {snapshot && snapshot.profile !== 'upstream' && <span className="aif-profile">{profileNames[snapshot.profile]}</span>}
      <div className="aif-header-actions">
        {hasPreparation && <button className="aif-header-button" type="button" disabled={savingPreparation}
          aria-label={preparationVisible ? 'Скрыть подготовку проекта' : 'Показать подготовку проекта'} aria-expanded={preparationVisible}
          aria-controls={preparationId} title={preparationVisible ? 'Скрыть подготовку проекта' : 'Показать подготовку проекта'}
          onClick={() => void togglePreparation(!preparationVisible)}><Icon name="ListTodo" className="aif-button-icon" aria-hidden="true" /></button>}
        {snapshot && <button className="aif-header-button" type="button" aria-label="Версии и обновления" title="Версии и обновления"
          aria-expanded={updatesOpen} aria-controls={updatesId} data-update={showUpdateIndicator || undefined}
          onClick={() => {
            const details = updatesDetails.current;
            if (!details) return;
            details.open = !details.open;
            if (details.open) details.querySelector('summary')?.focus();
          }}><Icon name="PackageReceive" className="aif-button-icon" aria-hidden="true" /></button>}
        <button className="aif-header-button" type="button" onClick={() => void refresh(false, true)} aria-label="Обновить статус AI Factory" title="Перечитать задачи и проверки; версии CLI/Git и GitHub кэшируются на сутки"><Icon name="RotateCcw" className="aif-button-icon" aria-hidden="true" /></button>
      </div>
    </header>
    {loading && <p role="status" className="aif-muted">Читаю локальный статус…</p>}
    {error && <p role="alert" className="aif-error">{error}</p>}
    {notice && <p role="status" className="aif-notice">{notice}</p>}
    {snapshot && <>
      <dl className="aif-versions" aria-label="Версии AI Factory">
        <div><dt>CLI</dt><dd>{snapshot.versions.globalCli ?? 'не найден'}</dd></div>
        <div><dt>Проект</dt><dd>{snapshot.versions.installed ?? 'не указан'}</dd></div>
        {snapshot.versions.sourceVersion && <div><dt>Git</dt><dd>{snapshot.versions.sourceVersion}
          {snapshot.versions.sourceSha && <small>@{snapshot.versions.sourceSha.slice(0, 7)}</small>}
          {snapshot.versions.sourceDirty && <small>изменён</small>}</dd></div>}
        {snapshot.extensions.map(e => <div key={e.name} title={e.installedVersion ? 'Установленная версия расширения' : 'Записанная версия; установленные файлы не подтверждены'}>
          <dt>{e.name}</dt><dd>{e.installedVersion ?? e.recordedVersion ?? 'неизвестна'}{!e.installedVersion && <small>не подтверждена</small>}</dd>
        </div>)}
      </dl>
      {hasPreparation && <section id={preparationId} className="aif-preparation" aria-label="Подготовка проекта" hidden={!preparationVisible}>
        {preparationVisible && <><h3>Подготовка проекта</h3>{setupContent}</>}
      </section>}
      <section className="aif-current" aria-label="Текущий этап">
        <div className="aif-section-caption">Сейчас</div>
        <div className="aif-stage" title={snapshot.phaseSource}>
          <strong>{phaseNames[snapshot.phase]}</strong>
          <span className={`aif-agent-state${busy ? ' aif-agent-state-active' : ''}`}>
            <span className={busy ? 'aif-live-dot' : 'aif-idle-dot'} aria-hidden="true" />
            {snapshot.pendingQuestions ? `ожидаю ответы: ${snapshot.pendingQuestions}` : snapshot.pendingConfirmation ? 'ожидается подтверждение пользователя' : snapshot.pendingConfirmation === null ? 'ожидание подтверждения не проверено' : busy ? 'агент занят' : snapshot.threadState === 'error' ? 'ошибка выполнения BB' : 'агент свободен'}
          </span>
        </div>
        {usesBasicWorkflow(snapshot) && <p className="aif-muted" aria-label="Базовый workflow">Без AI Factory доступен встроенный flow: исследование → Plan BB → выполнение → проверка → коммит. «Составить план» включает штатный режим Plan.{hasPreparation && ' Установка доступна в «Подготовке проекта».'}</p>}
        {snapshot.rulesSync && <p className="aif-error" role="status">В последнем ответе правила выбранного change отмечены как устаревшие. Синхронизируйте их перед выполнением.</p>}
        {sessionBriefBlocked(snapshot) && <p className="aif-error" role="status" aria-label="Блокировка SessionBrief">SessionBrief: {snapshot.sessionBrief!.status.toUpperCase()} · из чата. Выполнение остановлено. Синхронизируйте выбранный change, затем пересоберите SessionBrief. Актуальность контекста проверяет владелец workflow.</p>}
        {snapshot.fixDefaults && <p className="aif-muted aif-small">Fix: <code>{snapshot.fixDefaults.mode}</code> · learning patch: {snapshot.fixDefaults.patch ? 'включён' : 'выключен'} · настройки применяет aif-fix</p>}
        {snapshot.candidates.length > 0 && <label className="aif-target">План
          <select aria-label="Выбранный план или change" value={snapshot.target?.path ?? target} onChange={e => { setTarget(e.target.value); setNewTask(false); setNotice(''); }}>
            {!snapshot.target && <option value="">Выберите задачу</option>}
            {!showCompleted && snapshot.target && hiddenPlans.some(t => t.path === snapshot.target!.path) && <option value={snapshot.target.path} hidden>{snapshot.target.title} · завершён</option>}
            {visiblePlans.map(t => <option key={t.path} value={t.path} title={t.path}>{t.title}{t.progress ? ` · выполнено ${t.progress.completed} из ${t.progress.total}` : ''}{t.closed ? ' · закрыт' : ''} · {t.kind}</option>)}
          </select></label>}
        {hiddenPlans.length > 0 && <label className="aif-show-completed"><input type="checkbox" checked={showCompleted} onChange={event => setShowCompleted(event.target.checked)} />Показать завершённые ({hiddenPlans.length})</label>}
        {snapshot.target && <div className="aif-progress"><div><strong>{snapshot.target.title}</strong><span className="aif-task-count">{completed}/{tasks.length} задач</span></div>
          {snapshot.target.verification?.verified && <small className="aif-muted" title="Отметка владельца проверки в файле плана">План отмечен проверенным</small>}
          <progress aria-label="Выполнение задач плана" value={completed} max={Math.max(tasks.length, 1)} />
          {snapshot.target.settings && Object.values(snapshot.target.settings).some(Boolean) && <p className="aif-muted aif-small" aria-label="Настройки плана">Коммиты: <code>{snapshot.target.settings.commitStrategy ?? 'не указано'}</code> · Метод: <code>{snapshot.target.settings.methodology ?? 'не указан'}</code>{snapshot.target.settings.tddGranularity && <> · TDD: <code>{snapshot.target.settings.tddGranularity}</code></>}</p>}
          <details><summary>Задачи плана</summary><ul className="aif-tasks">{tasks.map((t, i) => <li key={`${t.id}-${i}`}><span className={t.done ? 'aif-task-done' : 'aif-muted'} role="img" aria-label={t.outcome === 'skipped' ? 'Пропущена по плану' : t.done ? 'Выполнена по плану' : 'Не выполнена'}><Icon name={t.outcome === 'skipped' ? 'Minus' : t.done ? 'CircleCheck' : 'Circle'} className="aif-button-icon" aria-hidden="true" /></span><span>{t.title}{t.kind === 'commit' && <small className="aif-muted"> · коммит</small>}{t.outcome === 'skipped' && <small className="aif-muted"> · пропущено по плану</small>}</span></li>)}</ul>
            {!tasks.length && <p className="aif-muted">Чекбоксы задач не найдены; прогресс неизвестен.</p>}</details>
        </div>}
        {snapshot.chatPlan && !snapshot.target && <div className="aif-progress" aria-label="План из чата">
          <strong>{snapshot.chatPlan.title}</strong>
          <p className="aif-muted aif-small">{snapshot.chatPlan.accepted ? 'Выполнение плана запрошено' : 'План предложен · ожидает запуска'} · сообщение #{snapshot.chatPlan.seq}. Прогресс задач и результаты проверок не подтверждены.</p>
        </div>}
        <div className="aif-next-actions">{renderActions(snapshot.actions.filter(a => a.group === 'next' && !(newResearch && a.id === 'basic-explore')).slice(0, 3))}</div>
        {newResearch && <div className="aif-actions" role="group" aria-label="Новая задача">{renderAction(researchAction)}</div>}
        {researchOpen && researchAction && <form className="aif-research-form" aria-label="Описание исследования" onSubmit={event => {
          event.preventDefault();
          if (!researchTask.trim() || busy || sending || !researchAction.available) return;
          void run(researchAction, researchTask.trim());
        }}>
          <label>Что исследовать?
            <textarea autoFocus required maxLength={RESEARCH_TASK_MAX_LENGTH} rows={4} value={researchTask} disabled={sending || busy}
              placeholder="Опишите вопрос, проблему или укажите ссылку на задачу" onChange={event => setResearchTask(event.target.value)} />
          </label>
          <p className="aif-muted aif-small">До {RESEARCH_TASK_MAX_LENGTH} символов. Исследование изучает задачу и код, не меняя файлы.</p>
          {researchError && <p role="alert" className="aif-error">{researchError}</p>}
          <div className="aif-actions">
            <button type="submit" className="aif-action" disabled={!researchTask.trim() || sending || busy || !researchAction.available}><ActionIcon id="explore" />Начать исследование</button>
            <button type="button" className="aif-action aif-secondary" disabled={sending} onClick={() => { setResearchOpen(false); setResearchTask(''); setResearchError(''); }}><Icon name="X" className="aif-button-icon" aria-hidden="true" />Отмена</button>
          </div>
        </form>}
      </section>
      {maintenance.length > 0 && <div className="aif-maintenance" role="group" aria-label="Установка и настройка AI Factory">{renderActions(maintenance)}</div>}
      {!hasPreparation && snapshot.actions.some(a => contextSetupInDetails(snapshot, a.id)) && <details className="aif-context-setup"><summary>Настройка контекста проекта</summary>
        <p className="aif-muted aif-small">Выполнение плана уже начато. Настройка контекста запускается отдельно и не продолжает выбранный план.</p>
        {renderActions(snapshot.actions.filter(a => contextSetupInDetails(snapshot, a.id)))}
      </details>}
      {snapshot.checks.length > 0 && <CheckPanel checks={snapshot.checks} actions={snapshot.actions} renderAction={renderAction}
        openReport={openFile ? path => { if (!openFile(path)) setError('Просмотр файла недоступен в этой поверхности.'); } : undefined} />}
      <details id={updatesId} ref={updatesDetails} className="aif-details aif-disclosure" onToggle={event => setUpdatesOpen(event.currentTarget.open)}>
        <summary>Версии и расширения{snapshot.extensions.length ? ` · ${snapshot.extensions.length}` : ''}</summary>
        <div className="aif-disclosure-body">
          {updates.length > 0 && renderActions(updates)}
          {snapshot.versionsCheckedAt && <p className="aif-muted aif-small">Версии CLI/Git: снимок от {new Date(snapshot.versionsCheckedAt).toLocaleString('ru')}. Плановая проверка — раз в сутки.</p>}
          <dl><dt>Глобальный CLI</dt><dd>{snapshot.versions.globalCli ?? 'Не найден'}{snapshot.versions.globalSource && <small>{snapshot.versions.globalSource}</small>}</dd>
            <dt>Установка проекта</dt><dd>{snapshot.versions.installed ?? 'Не указана'} · {snapshot.runtime}</dd>
            <dt>Исходники Git</dt><dd>{snapshot.versions.sourceVersion ?? 'Checkout не задан'}{snapshot.versions.sourceSha && <small>{snapshot.versions.sourceSha}</small>}
              {snapshot.versions.sourceWorktreeVersion && snapshot.versions.sourceWorktreeVersion !== snapshot.versions.sourceVersion && <small>Рабочее дерево: {snapshot.versions.sourceWorktreeVersion}</small>}</dd>
            <dt>Git upstream</dt><dd>{snapshot.upstream.version ?? 'Не проверен'}{snapshot.upstream.ref && ` · ${snapshot.upstream.ref} @${snapshot.upstream.sha?.slice(0, 7)}`}
              {snapshot.upstream.checkedAt && <small>Проверено {new Date(snapshot.upstream.checkedAt).toLocaleString()}</small>}{snapshot.upstream.error && <small>{snapshot.upstream.error}</small>}</dd></dl>
          <button type="button" className="aif-action aif-secondary" disabled={network || nextVersionCheck > Date.now()} title={nextVersionCheck > Date.now() ? `Следующая проверка доступна ${new Date(nextVersionCheck).toLocaleString('ru')}` : 'Проверить upstream; результат сохраняется на сутки'} onClick={async () => { setNetwork(true); try { await refresh(true); } finally { if (mounted.current) setNetwork(false); } }}><Icon name="Github" className="aif-button-icon" aria-hidden="true" />{network ? 'Проверяю GitHub…' : 'Проверить версию в GitHub'}</button>
          {nextVersionCheck > Date.now() && <p className="aif-muted aif-small">Следующая проверка GitHub — {new Date(nextVersionCheck).toLocaleString('ru')}.</p>}
          {snapshot.extensions.length ? <ul className="aif-extensions">{snapshot.extensions.map(e => <li key={e.name}><strong>{e.name}</strong> {e.installedVersion ?? 'файлы отсутствуют'} <span className="aif-muted">· {e.state}</span>
            <small>Записано: {e.recordedVersion ?? 'не указано'} · {e.source}</small>{e.contributions.length > 0 && <small>Настроенные injections: {e.contributions.join(', ')}. Это не подтверждение загрузки в текущую сессию.</small>}</li>)}</ul> : <p className="aif-muted">Расширения не зарегистрированы в этом проекте.</p>}
        </div>
      </details>
      {snapshot.diagnostics.length > 0 && <details className="aif-diagnostics aif-disclosure">
        <summary>Примечания · {snapshot.diagnostics.length}</summary>
        <div className="aif-disclosure-body"><ul>{snapshot.diagnostics.map((d, i) => <li key={i}>{d}</li>)}</ul></div>
      </details>}
      <footer className="aif-footer">
        <span className="aif-footer-source">
          <Icon name="Clock" className="aif-button-icon" aria-hidden="true" />
          <span>{snapshot.cache?.source === 'saved' ? 'Сохранённые данные' : snapshot.cache?.source === 'memory' ? 'Данные из кэша' : 'Локальный статус'}</span>
          <time dateTime={snapshot.collectedAt}>{new Date(snapshot.collectedAt).toLocaleTimeString()}</time>
        </span>
        {snapshot.cache?.refreshing && <span>Обновляются в фоне…</span>}
        {snapshot.cache?.refreshError && <span>Обновление не удалось. Нажмите ↻ для повторного чтения.</span>}
        {busy && <span>{snapshot.pendingConfirmation || snapshot.pendingQuestions ? 'Действия доступны после ответа пользователя' : 'Действия доступны после завершения работы'}</span>}
      </footer>
    </>}
  </section>;
}
function Directive(props: PluginMessageDirectiveProps) {
  // Legacy directives have no identity; hide their historical output as well.
  const cardId = cardIdSchema.safeParse(props.attributes.card);
  if (!cardId.success) return null;
  const parsed = phaseSchema.safeParse(props.attributes.phase ?? 'unknown');
  if (!parsed.success || (props.attributes.target?.length ?? 0) > 1000) return <p className="aif-error">Некорректная карточка AI Factory.</p>;
  return <InlineCard key={`${props.message.threadId}:${cardId.data}`} cardId={cardId.data} threadId={props.message.threadId}
    initialTarget={props.attributes.target ?? ''} phase={parsed.data} openFile={props.openWorkspaceFile} />;
}
function InlineCard({ cardId, threadId, initialTarget, phase, openFile }: {
  cardId: string; threadId: string; initialTarget: string; phase: Phase; openFile: PluginMessageDirectiveProps['openWorkspaceFile'];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<'current' | 'superseded' | 'hidden'>('hidden');
  const mounted = useRef(true);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (state === 'superseded') return;
    const id = ++sequence.current;
    try {
      const result = await rpc.call('cardVisibility', { threadId, cardId });
      if (mounted.current && sequence.current === id) setState(result.state);
    } catch { if (mounted.current && sequence.current === id) setState('hidden'); }
  }, [rpc, threadId, cardId, state]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  useEffect(() => {
    if (state === 'superseded') return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    return () => window.clearInterval(timer);
  }, [refresh, state]);
  useRealtime('changed', (payload: unknown) => { if ((payload as { threadId?: string })?.threadId === threadId) void refresh(); });
  return state === 'current' ? <WorkflowCard threadId={threadId} initialTarget={initialTarget} phase={phase} openFile={openFile} inline /> : null;
}
function ContextCard({ threadId }: ExperimentalThreadContextCardProps) { return <WorkflowCard threadId={threadId} compact />; }
function WorkflowPanel({ threadId }: ExperimentalThreadTabProps) { return <div className="aif-panel"><WorkflowCard key={threadId} threadId={threadId} compact /></div>; }
function SuggestedCommands() {
  const composer = useComposer();
  return composer.scope.kind === 'thread' ? <SuggestionBar key={composer.scope.threadId} threadId={composer.scope.threadId} composerBusy={composer.isRunning || composer.isSubmitting} /> : null;
}
function SuggestionBar({ threadId, composerBusy }: { threadId: string; composerBusy: boolean }) {
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
        if (mounted.current) setNotice(result.message);
      }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { await refresh(); operation.current = false; if (mounted.current) setWorking(false); }
  }
  const busy = composerBusy || !!data && !['idle', 'error'].includes(data.threadState);
  if (!data?.items.length && !data?.gate && !data?.gateError && !error && !notice) return null;
  return <section className="aif-suggestions" aria-label="Команды из последнего ответа агента">
    {(data?.gate || data?.gateError) && <div className={`aif-message-gate${data.gate?.blocking || data.gateError ? ' aif-message-gate-blocking' : ''}`} role="group" aria-label="Gate из последнего ответа">
      {data.gate && <><div className="aif-message-gate-heading"><strong>{data.gate.gate} · {data.gate.status.toUpperCase()} в ответе</strong><span>{data.gate.blocking ? 'Блокирует следующий этап' : data.gateWarning ? 'Переход не подтверждён' : 'Не блокирует'}</span></div>
        <p className="aif-muted aif-small">Заявленный результат из чата. Актуальность evidence для текущих inputs проверяет владелец workflow.</p>
        {data.gate.blockers.length ? <details open><summary>Блокирующие проблемы · {data.gate.blockers.length}</summary><ul>{data.gate.blockers.map((b, i) => <li key={`${b.id}-${i}`}><strong>{b.id}</strong> <span className="aif-muted">· {b.severity}</span><p>{b.summary}</p>{b.file && <code>{b.file}</code>}</li>)}</ul></details> : <p className="aif-small">Блокирующих проблем нет.</p>}
        {data.gate.suggested_next?.reason && <p className="aif-small"><strong>{data.gate.suggested_next.command ? 'Следующий шаг: ' : 'Пояснение: '}</strong>{data.gate.suggested_next.reason}</p>}
        {!!data.gate.affected_files.length && <details><summary>Затронутые файлы · {data.gate.affected_files.length}</summary><ul>{data.gate.affected_files.map((file, i) => <li key={i}><code>{file}</code></li>)}</ul></details>}
      </>}
      {data.gateError && <p className="aif-error" role="alert">Некорректный gate: {data.gateError}</p>}
      {data.gateWarning && <p className="aif-muted aif-small" role="note">Формат ответа: {data.gateWarning}</p>}
    </div>}
    {!!data?.items.length && <><span className="aif-suggestions-label">Из ответа агента</span><div className="aif-suggestion-list">{data.items.map(item => <div className="aif-suggestion-entry" key={item.id}><div className="aif-suggestion">
      <button type="button" className="aif-suggestion-run" disabled={working || (busy && !(item.kind === 'improve-approval' && !composerBusy && data.threadState === 'awaiting_input')) || !item.available} title={item.kind === 'improve-approval' ? item.reason : busy ? 'Дождитесь завершения текущей работы' : item.reason} onClick={() => void act(item.id, false)}><ActionIcon id={item.kind === 'improve-approval' ? 'apply-improvements' : item.id} command={item.command} /><span>{item.label ?? item.command}</span></button>
      <button type="button" className="aif-suggestion-dismiss" disabled={working} aria-label={`Удалить предложение ${item.label ?? item.command}`} title="Убрать из предложений этого ответа" onClick={() => void act(item.id, true)}>×</button>
    </div>{!item.available && <p className="aif-suggestion-reason" role="note">{item.reason}</p>}</div>)}</div></>}
    {error && <p className="aif-error" role="alert">{error}</p>}
    {notice && <p className="aif-muted aif-small" role="status">{notice}</p>}
  </section>;
}
export default definePluginApp(app => {
  app.slots.experimental_codeFenceRenderer({ id: 'gate-data', languages: ['aif-gate-result'], component: GateData });
  app.slots.experimental_codeFenceRenderer({ id: 'plan-document', languages: ['aif-plan'], component: PlanDocument });
  app.contentScripts.register({ id: 'plan-presentation', mount: mountPlanPresentation });
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
