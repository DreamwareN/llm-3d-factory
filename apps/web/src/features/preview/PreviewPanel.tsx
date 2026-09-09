import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CameraIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  DownloadIcon,
  AlertTriangleIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useAppStore } from '@/stores/useAppStore';
import { buildSandboxDocument, sandbox } from './sandbox-controller';

function downloadDataUrl(dataUrl: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
}

function downloadBase64(base64: string, mime: string, filename: string): void {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PreviewPanel({ projectId }: { projectId: string }) {
  const runtime = useAppStore((state) => state.projectStates[projectId]);
  const snapshotAt = useAppStore((state) => state.projectStates[projectId]?.snapshotAt ?? 0);
  const markPreviewReady = useAppStore((state) => state.markPreviewReady);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadedKeyRef = useRef('');
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingScene, setLoadingScene] = useState(false);
  const srcDoc = useMemo(() => buildSandboxDocument(), []);

  const loadScene = useCallback(
    async (notifyServer: boolean) => {
      setLoadingScene(true);
      try {
        const scene = await api.projects.fetchSceneGlb(projectId);
        const lighting = useAppStore.getState().projectStates[projectId]?.scene?.lighting;
        await sandbox.loadScene({
          ...(scene ? { dataBase64: scene.dataBase64 } : {}),
          ...(lighting ? { lighting } : {}),
        });
        if (notifyServer) markPreviewReady(projectId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setLoadingScene(false);
      }
    },
    [projectId, markPreviewReady],
  );

  useEffect(() => {
    loadedKeyRef.current = '';
    const iframe = iframeRef.current;
    if (!iframe) return;
    sandbox.attach(iframe, projectId);
    sandbox.onStalled = () => {
      toast.warning('预览渲染器无响应，正在重建…');
      setReloadKey((value) => value + 1);
    };
  }, [projectId, reloadKey]);

  useEffect(() => {
    if (snapshotAt === 0) return;
    const key = `${projectId}:${reloadKey}`;
    if (loadedKeyRef.current === key) return;
    let cancelled = false;
    void sandbox.whenReady().then(() => {
      if (cancelled) return;
      loadedKeyRef.current = key;
      void loadScene(true);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey, snapshotAt, loadScene]);

  // Only fully detach when the panel unmounts. Switching projects reuses the
  // live sandbox so the iframe (and its WebGL context) is never reloaded.
  useEffect(() => () => sandbox.detach(), []);

  const scene = runtime?.scene ?? null;
  const status = runtime?.previewStatus ?? 'idle';

  const resetView = async () => {
    try {
      await sandbox.setCamera({ preset: 'perspective' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const capture = async () => {
    setBusy('capture');
    try {
      const result = await sandbox.screenshot({ view: 'current' });
      downloadDataUrl(result.dataUrl, `preview-${Date.now()}.png`);
      toast.success('已保存截图');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const exportGlb = async () => {
    setBusy('export');
    try {
      const result = await sandbox.exportGlb();
      downloadBase64(result.dataBase64, 'model/gltf-binary', `model-${Date.now()}.glb`);
      toast.success(`已导出 GLB（${formatBytes(result.size)}）`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          {status === 'loading' || loadingScene ? (
            <Badge variant="secondary" className="gap-1">
              <Spinner />
              加载中
            </Badge>
          ) : status === 'error' ? (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangleIcon />
              渲染错误
            </Badge>
          ) : status === 'ready' ? (
            <Badge variant="outline" className="gap-1 text-emerald-400">
              <span className="size-1.5 rounded-full bg-current" />
              渲染正常
            </Badge>
          ) : (
            <Badge variant="outline">等待场景</Badge>
          )}
          {scene ? (
            <span className="text-xs text-muted-foreground">GLB {formatBytes(scene.size)}</span>
          ) : null}
        </div>

        <Separator orientation="vertical" className="mx-1 h-4" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void loadScene(false)}
              disabled={loadingScene}
            >
              <RefreshCwIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>重新加载场景 GLB</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => void resetView()}>
              <RotateCcwIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>重置相机视角</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void capture()}
              disabled={busy !== null}
            >
              <CameraIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>截图并保存 PNG</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void exportGlb()}
              disabled={busy !== null}
            >
              <DownloadIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>导出当前场景为 GLB</TooltipContent>
        </Tooltip>
      </div>

      {status === 'error' && runtime?.previewError ? (
        <Alert variant="destructive" className="m-2 shrink-0">
          <AlertTitle>场景执行失败</AlertTitle>
          <AlertDescription>
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-xs">
              {runtime.previewError}
            </pre>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-[#101216]">
        <iframe
          key={reloadKey}
          ref={iframeRef}
          title="Three.js 预览"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="absolute inset-0 size-full border-0"
        />
        {!scene && !loadingScene ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            等待模型创建场景…
          </div>
        ) : null}
      </div>
    </div>
  );
}
