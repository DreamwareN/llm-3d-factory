import {
  MessageSquareIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlayIcon,
  SquareIcon,
  WifiIcon,
  WifiOffIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConversationStatusBadge } from '@/features/conversations/ConversationStatusBadge';
import { ModelSwitchButton } from '@/features/conversations/ModelSwitchButton';
import { useIsDesktop } from '@/hooks/use-media-query';
import { isGenerating, useAppStore } from '@/stores/useAppStore';

interface TopBarProps {
  rightPanelOpen: boolean;
  onToggleRightPanel: () => void;
  onOpenChat: () => void;
}

export function TopBar({ rightPanelOpen, onToggleRightPanel, onOpenChat }: TopBarProps) {
  const isDesktop = useIsDesktop();
  const connected = useAppStore((state) => state.connected);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const project = useAppStore((state) =>
    state.selectedProjectId ? state.projectStates[state.selectedProjectId] : undefined,
  );
  const runtime = useAppStore((state) =>
    state.selectedProjectId && state.activeConversationId
      ? state.projectStates[state.selectedProjectId]?.conversations[state.activeConversationId]
      : undefined,
  );
  const cancelConversation = useAppStore((state) => state.cancelConversation);
  const startConversation = useAppStore((state) => state.startConversation);

  const conversation = runtime?.conversation;
  const generating = conversation ? isGenerating(conversation.status) : false;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <SidebarTrigger className="-ml-1 shrink-0" />

      <div className="flex min-w-0 flex-1 items-center gap-3">
        {project ? (
          <>
            <span className="truncate text-sm font-semibold">{project.project.name}</span>
            <Separator orientation="vertical" className="hidden h-4 sm:block" />
            {conversation ? (
              <>
                <span className="truncate text-sm text-muted-foreground">{conversation.title}</span>
                <span className="hidden sm:inline-flex">
                  <ConversationStatusBadge status={conversation.status} />
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">未选择对话</span>
            )}
            {project.operations.length > 0 ? (
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {project.operations.length} ops
              </Badge>
            ) : null}
          </>
        ) : (
          <span className="text-sm text-muted-foreground">未选择项目</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {conversation && activeConversationId ? (
          generating ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => cancelConversation(activeConversationId)}
            >
              <SquareIcon data-icon="inline-start" />
              <span className="hidden sm:inline">停止</span>
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!runtime?.messages.some((message) => message.role === 'user')}
              onClick={() => {
                const lastUser = [...(runtime?.messages ?? [])]
                  .reverse()
                  .find((message) => message.role === 'user');
                const text = lastUser?.parts.find((part) => part.type === 'text');
                if (text && text.type === 'text') {
                  startConversation(activeConversationId, text.text);
                }
              }}
            >
              <PlayIcon data-icon="inline-start" />
              <span className="hidden sm:inline">重新生成</span>
            </Button>
          )
        ) : null}

        {isDesktop && !rightPanelOpen && activeConversationId ? (
          <ModelSwitchButton conversationId={activeConversationId} className="max-w-[180px]" />
        ) : null}

        {isDesktop ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onToggleRightPanel}>
                {rightPanelOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{rightPanelOpen ? '收起右侧面板' : '展开右侧面板'}</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onOpenChat}>
                <MessageSquareIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>对话与进度</TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center px-1 text-muted-foreground">
              {connected ? (
                <WifiIcon className="size-3.5 text-emerald-400" />
              ) : (
                <WifiOffIcon className="size-3.5 text-red-400" />
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent>{connected ? 'WebSocket 已连接' : 'WebSocket 未连接'}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
