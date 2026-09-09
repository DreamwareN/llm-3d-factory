import { Progress } from '@/components/ui/progress';
import { isGenerating, useAppStore } from '@/stores/useAppStore';

export function TurnProgress({ conversationId }: { conversationId: string | null }) {
  const runtime = useAppStore((state) => {
    if (!conversationId) return undefined;
    for (const project of Object.values(state.projectStates)) {
      const entry = project.conversations[conversationId];
      if (entry) return entry;
    }
    return undefined;
  });

  if (!runtime || !isGenerating(runtime.conversation.status)) return null;

  const steps = runtime.timeline.filter((item) => item.kind === 'step');
  const toolCalls = runtime.timeline.filter((item) => item.kind === 'tool').length;
  const maxSteps = runtime.conversation.config.maxSteps;
  const latest = [...runtime.timeline]
    .reverse()
    .find((item) => item.kind === 'step' || item.kind === 'tool' || item.kind === 'scene');

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-background/85 px-3 py-2 shadow backdrop-blur">
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="truncate">{latest?.title ?? '生成中…'}</span>
        <span className="shrink-0 tabular-nums">
          {steps.length}/{maxSteps} 步 · {toolCalls} 次调用
        </span>
      </div>
      <Progress value={maxSteps > 0 ? (steps.length / maxSteps) * 100 : 0} className="h-1" />
    </div>
  );
}
