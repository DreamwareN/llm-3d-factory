import {
  AlertTriangleIcon,
  CameraIcon,
  CheckCircle2Icon,
  CircleIcon,
  CodeIcon,
  DownloadIcon,
  LayersIcon,
  Loader2Icon,
} from 'lucide-react';
import type { TimelineItem } from '@llm3d/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatDuration, formatTime, formatTokens } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/useAppStore';

const KIND_ICONS = {
  status: CircleIcon,
  step: Loader2Icon,
  tool: CodeIcon,
  scene: LayersIcon,
  artifact: CameraIcon,
  error: AlertTriangleIcon,
} as const;

interface TimelineGroup {
  key: string;
  step: TimelineItem | null;
  items: TimelineItem[];
}

/**
 * The timeline is a flat append-ordered list: each step item is followed by the
 * tools/scene/artifact items it produced. Grouping keeps a tool visually under
 * its own step instead of the previous one when the list is rendered newest
 * first (which made tool durations look longer than their step).
 */
function groupTimeline(timeline: TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let current: TimelineGroup = { key: 'head', step: null, items: [] };
  for (const item of timeline) {
    if (item.kind === 'step') {
      current = { key: item.id, step: item, items: [] };
      groups.push(current);
    } else {
      current.items.push(item);
    }
  }
  return groups;
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const Icon = KIND_ICONS[item.kind] ?? CircleIcon;
  const running = item.status === 'running';
  const failed = item.status === 'error';
  return (
    <div className="flex gap-2.5 px-3 py-2">
      <div className="mt-0.5 shrink-0">
        {running ? (
          <Loader2Icon className="size-3.5 animate-spin text-amber-400" />
        ) : failed ? (
          <AlertTriangleIcon className="size-3.5 text-red-400" />
        ) : (
          <Icon
            className={cn(
              'size-3.5',
              item.kind === 'artifact' ? 'text-sky-400' : 'text-muted-foreground',
            )}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium">{item.title}</span>
          {item.endedAt ? (
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {formatDuration(item.endedAt - item.startedAt)}
            </span>
          ) : (
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {formatTime(item.startedAt)}
            </span>
          )}
        </div>
        {item.detail ? (
          <div className="mt-0.5 line-clamp-2 break-all text-[11px] text-muted-foreground">
            {item.detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ProgressPanel({
  conversationId,
  projectId,
}: {
  conversationId: string;
  projectId: string;
}) {
  const conversation = useAppStore((state) => {
    for (const project of Object.values(state.projectStates)) {
      const entry = project.conversations[conversationId];
      if (entry) return entry;
    }
    return undefined;
  });
  const project = useAppStore((state) => state.projectStates[projectId]);
  if (!conversation || !project) return null;

  const { usage, timeline } = conversation;
  const { operations, artifacts } = project;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid shrink-0 grid-cols-2 gap-2 border-b p-3">
        <Card className="gap-0 py-3">
          <CardHeader className="px-3 pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">输入 Tokens</CardTitle>
          </CardHeader>
          <CardContent className="px-3">
            <span className="text-lg font-semibold">{formatTokens(usage.inputTokens)}</span>
          </CardContent>
        </Card>
        <Card className="gap-0 py-3">
          <CardHeader className="px-3 pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">输出 Tokens</CardTitle>
          </CardHeader>
          <CardContent className="px-3">
            <span className="text-lg font-semibold">{formatTokens(usage.outputTokens)}</span>
          </CardContent>
        </Card>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {operations.length > 0 ? (
          <Badge variant="secondary" className="gap-1">
            <CheckCircle2Icon />
            {operations.length} 个场景操作
          </Badge>
        ) : (
          <Badge variant="outline">暂无场景</Badge>
        )}
        <Badge variant="outline" className="gap-1">
          <CameraIcon />
          {artifacts.length} 个产物
        </Badge>
        <Badge variant="outline" className="gap-1">
          <DownloadIcon />
          {timeline.filter((item) => item.kind === 'tool').length} 次工具调用
        </Badge>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col divide-y pb-40">
          {timeline.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">等待模型开始生成…</div>
          ) : (
            groupTimeline(timeline)
              .reverse()
              .map((group) => (
                <div key={group.key} className="flex flex-col divide-y">
                  {group.step ? <TimelineRow item={group.step} /> : null}
                  {group.items.map((item) => (
                    <TimelineRow key={item.id} item={item} />
                  ))}
                </div>
              ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
