import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { ConversationStatus } from '@llm3d/shared';

const STATUS_META: Record<ConversationStatus, { label: string; className: string }> = {
  idle: { label: '空闲', className: 'text-muted-foreground' },
  running: { label: '生成中', className: 'text-emerald-400' },
  failed: { label: '失败', className: 'text-red-400' },
};

export function ConversationStatusBadge({ status }: { status: ConversationStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant="outline" className={cn('gap-1', meta.className)}>
      {status === 'running' ? (
        <Spinner className="size-3" />
      ) : (
        <span className="size-1.5 rounded-full bg-current" />
      )}
      {meta.label}
    </Badge>
  );
}

export function StatusDot({ status }: { status: ConversationStatus }) {
  return (
    <span className="relative flex size-2">
      {status === 'running' && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
      )}
      <span
        className={cn(
          'relative inline-flex size-2 rounded-full',
          status === 'running'
            ? 'bg-emerald-400'
            : status === 'failed'
              ? 'bg-red-400'
              : 'bg-muted-foreground/50',
        )}
      />
    </span>
  );
}
