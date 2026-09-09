import { useState } from 'react';
import {
  AlertTriangleIcon,
  BoxIcon,
  CameraIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  FileSearchIcon,
  GroupIcon,
  HammerIcon,
  LayersIcon,
  LightbulbIcon,
  Loader2Icon,
  Move3dIcon,
  PaletteIcon,
  ScissorsIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react';
import type { MessagePart } from '@llm3d/shared';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

type ToolCallPart = Extract<MessagePart, { type: 'tool-call' }>;

const TOOL_META: Record<string, { label: string; icon: typeof WrenchIcon }> = {
  create_primitive: { label: '创建几何体', icon: BoxIcon },
  create_extrude_mesh: { label: '拉伸轮廓', icon: LayersIcon },
  boolean_mesh: { label: '布尔运算', icon: ScissorsIcon },
  duplicate_object: { label: '阵列复制', icon: CopyIcon },
  transform_object: { label: '变换对象', icon: Move3dIcon },
  align_object: { label: 'AABB 对齐', icon: Move3dIcon },
  group_objects: { label: '编组', icon: GroupIcon },
  delete_object: { label: '删除对象', icon: Trash2Icon },
  modify_material: { label: '修改材质', icon: PaletteIcon },
  setup_lighting: { label: '设置灯光', icon: LightbulbIcon },
  inspect_scene: { label: '检查场景', icon: FileSearchIcon },
  capture_viewport: { label: '视角截图', icon: CameraIcon },
  capture_multiview: { label: '多视角截图', icon: CameraIcon },
  eval_code_fallback: { label: '代码兜底', icon: CodeIcon },
  export_glb: { label: '导出 GLB', icon: DownloadIcon },
  finish: { label: '完成任务', icon: CheckCircle2Icon },
};

function summarize(value: unknown, max = 4000): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

export function ToolCallCard({ part }: { part: ToolCallPart }) {
  const [open, setOpen] = useState(part.state === 'error');
  const meta = TOOL_META[part.name] ?? { label: part.name, icon: HammerIcon };
  const Icon = meta.icon;
  const running = part.state === 'running';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-lg border bg-card">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50">
          <Icon className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">{meta.label}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{part.name}</span>
          {running ? (
            <Badge variant="secondary" className="ml-1 gap-1">
              <Loader2Icon className="animate-spin" />
              执行中
            </Badge>
          ) : part.state === 'error' ? (
            <Badge variant="destructive" className="ml-1">
              失败
            </Badge>
          ) : null}
          <ChevronRightIcon
            className={cn(
              'ml-auto size-3.5 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-2 border-t px-3 py-2">
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">参数</div>
              <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
                {summarize(part.input) || '{}'}
              </pre>
            </div>
            {part.error ? (
              <div>
                <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-destructive">
                  <AlertTriangleIcon className="size-3" />
                  错误
                </div>
                <pre className="max-h-40 overflow-auto rounded bg-destructive/10 p-2 font-mono text-[11px] leading-relaxed text-destructive">
                  {part.error}
                </pre>
              </div>
            ) : part.result !== undefined ? (
              <div>
                <div className="mb-1 text-[11px] font-medium text-muted-foreground">结果</div>
                <pre className="max-h-52 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
                  {summarize(part.result)}
                </pre>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
