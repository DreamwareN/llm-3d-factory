import { useState } from 'react';
import { ChevronRightIcon, LayersIcon } from 'lucide-react';
import type { SceneOperation } from '@llm3d/shared';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/useAppStore';

const TOOL_LABELS: Record<string, string> = {
  create_primitive: '创建基础几何体',
  create_extrude_mesh: '拉伸轮廓',
  boolean_mesh: 'CSG 布尔运算',
  duplicate_object: '阵列复制',
  transform_object: '变换对象',
  align_object: 'AABB 对齐',
  group_objects: '编组',
  delete_object: '删除对象',
  modify_material: '修改材质',
  setup_lighting: '设置灯光',
  eval_code_fallback: '代码兜底',
};

function vec3Text(value: [number, number, number] | undefined): string {
  if (!value) return '—';
  return value.map((entry) => entry.toFixed(2)).join(', ');
}

function OperationRow({ operation }: { operation: SceneOperation }) {
  const [open, setOpen] = useState(false);
  const result = operation.result;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-b">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50">
          <Badge variant="outline" className="font-mono text-[10px]">
            #{operation.seq}
          </Badge>
          <span className="text-xs font-medium">
            {TOOL_LABELS[operation.tool] ?? operation.tool}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {result.message ?? result.object_id ?? ''}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {formatTime(operation.createdAt)}
          </span>
          <ChevronRightIcon
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-2 px-3 pb-3">
            {result.aabb ? (
              <div className="grid grid-cols-2 gap-1 rounded bg-muted/60 p-2 font-mono text-[10px]">
                <span>min: {vec3Text(result.aabb.min)}</span>
                <span>max: {vec3Text(result.aabb.max)}</span>
                <span>size: {vec3Text(result.aabb.size)}</span>
                <span>center: {vec3Text(result.aabb.center)}</span>
              </div>
            ) : null}
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">参数</div>
              <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 font-mono text-[10px] leading-relaxed">
                {JSON.stringify(operation.input, null, 2)}
              </pre>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export function OperationsPanel({ projectId }: { projectId: string }) {
  const operations = useAppStore((state) => state.projectStates[projectId]?.operations ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <LayersIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">场景操作历史</span>
        <Badge variant="secondary">{operations.length}</Badge>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-40">
          {operations.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">还没有场景操作。</div>
          ) : (
            operations.map((operation) => (
              <OperationRow key={operation.id} operation={operation} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
