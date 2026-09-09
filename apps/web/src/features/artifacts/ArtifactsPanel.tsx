import { DownloadIcon, FileBoxIcon, PackageIcon } from 'lucide-react';
import type { ArtifactRecord } from '@llm3d/shared';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { formatBytes, formatTime } from '@/lib/format';
import { useAppStore } from '@/stores/useAppStore';

function ArtifactCard({ artifact }: { artifact: ArtifactRecord }) {
  const url = api.artifacts.downloadUrl(artifact.id);

  if (artifact.kind === 'png') {
    return (
      <a
        href={url}
        download={artifact.filename}
        title={artifact.filename}
        className="group flex flex-col overflow-hidden rounded-lg border transition-colors hover:border-primary/50"
      >
        <div className="aspect-video w-full overflow-hidden bg-muted">
          <img
            src={url}
            alt={artifact.filename}
            className="size-full object-cover transition-transform group-hover:scale-[1.02]"
          />
        </div>
        <div className="flex items-center gap-2 p-2">
          <span className="min-w-0 flex-1 truncate text-xs">{artifact.filename}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {formatBytes(artifact.size)}
          </span>
        </div>
      </a>
    );
  }

  return (
    <a
      href={url}
      download={artifact.filename}
      title={artifact.filename}
      className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
        <FileBoxIcon className="size-5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{artifact.filename}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {artifact.kind.toUpperCase()} · {formatBytes(artifact.size)} ·{' '}
          {formatTime(artifact.createdAt)}
        </div>
      </div>
      <DownloadIcon className="size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

export function ArtifactsPanel({ projectId }: { projectId: string }) {
  const artifacts = useAppStore((state) => state.projectStates[projectId]?.artifacts ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <PackageIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">产物</span>
        <Badge variant="secondary">{artifacts.length}</Badge>
      </div>

      {artifacts.length === 0 ? (
        <Empty className="min-h-0 flex-1 border-none">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageIcon />
            </EmptyMedia>
            <EmptyTitle>还没有产物</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-1 gap-3 p-3 pb-40 sm:grid-cols-2 xl:grid-cols-3">
            {artifacts.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
