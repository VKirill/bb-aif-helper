import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';

// Layout primitives for the panel. One grid: 16px between blocks, 12px inside a
// block, 8px between controls; host theme tokens only (bg-card, text-muted-foreground…).

export type Surface = 'panel' | 'card';
const SurfaceContext = createContext<Surface>('card');
export const SurfaceProvider = SurfaceContext.Provider;
export const useSurface = () => useContext(SurfaceContext);

export function Section({ id, title, aside, label, className, highlight = false, children }: { id?: string; title?: ReactNode; aside?: ReactNode; label: string; className?: string; highlight?: boolean; children: ReactNode }) {
  const surface = useSurface();
  if (surface === 'panel') {
    return <section id={id} aria-label={label} className={cn('flex min-w-0 scroll-mt-4 flex-col gap-2', className)}>
      {(title || aside) && <div className="flex min-w-0 items-center justify-between gap-2 px-4">
        {title && <h3 className={cn('m-0 text-xs', highlight ? 'font-medium text-foreground' : 'text-muted-foreground')}>{title}</h3>}
        {aside}
      </div>}
      {/* highlight: a section that needs action now gets the accent ring until it is done. */}
      <div className={cn('flex min-w-0 flex-col gap-3 rounded-xl bg-card px-4 py-3', highlight && 'ring-2 ring-primary/50')}>{children}</div>
    </section>;
  }
  return <section id={id} aria-label={label} className={cn('flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4', highlight ? 'border-primary/50' : 'border-border', className)}>
    {(title || aside) && <div className="flex min-w-0 items-center justify-between gap-2">
      {title && <h3 className="m-0 text-xs font-medium text-muted-foreground">{title}</h3>}
      {aside}
    </div>}
    {children}
  </section>;
}

/** Native <details> with BB's chevron; keeps keyboard and find-in-page behavior. */
export function Disclosure({ summary, className, open, children }: { summary: ReactNode; className?: string; open?: boolean; children: ReactNode }) {
  return <details className={cn('group min-w-0', className)} open={open}>
    <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-foreground outline-none hover:text-foreground/80 focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90" />
      {summary}
    </summary>
    <div className="flex flex-col gap-3 pt-2 pl-[22px]">{children}</div>
  </details>;
}

export type Tone = 'live' | 'done' | 'error' | 'idle';
export function StatusDot({ tone }: { tone: Tone }) {
  return <span aria-hidden="true" className={cn('relative inline-flex size-2 shrink-0 rounded-full',
    tone === 'live' && 'bg-primary', tone === 'done' && 'bg-foreground', tone === 'error' && 'bg-destructive', tone === 'idle' && 'bg-muted-foreground/60')}>
    {tone === 'live' && <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />}
  </span>;
}

export function Callout({ tone = 'info', role, children }: { tone?: 'info' | 'error'; role?: 'status' | 'alert'; children: ReactNode }) {
  return <p role={role} className={cn('m-0 rounded-md border px-3 py-2 text-xs',
    tone === 'error' ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-border bg-muted/40 text-foreground')}>{children}</p>;
}

/** BB buttons take no `title`: hints go through BB's tooltip. The span keeps hints on disabled buttons. */
export function Hint({ text, children }: { text?: string; children: ReactElement }) {
  if (!text) return children;
  return <TooltipProvider delayDuration={300}><Tooltip>
    <TooltipTrigger asChild><span className="inline-flex max-w-full">{children}</span></TooltipTrigger>
    <TooltipContent className="whitespace-pre-line">{text}</TooltipContent>
  </Tooltip></TooltipProvider>;
}
