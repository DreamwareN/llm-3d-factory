import { useEffect, useState } from 'react';
import {
  BoxIcon,
  LayersIcon,
  ListTreeIcon,
  MessageSquareIcon,
  PackageIcon,
  PanelRightCloseIcon,
  XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArtifactsPanel } from '@/features/artifacts/ArtifactsPanel';
import { ChatPanel } from '@/features/chat/ChatPanel';
import { Composer } from '@/features/chat/Composer';
import { AppSidebar } from '@/features/conversations/AppSidebar';
import { ModelSwitchButton } from '@/features/conversations/ModelSwitchButton';
import { OperationsPanel } from '@/features/editor/OperationsPanel';
import { PreviewPanel } from '@/features/preview/PreviewPanel';
import { ProgressPanel } from '@/features/progress/ProgressPanel';
import { useIsDesktop } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/useAppStore';
import { TopBar } from './TopBar';

const RIGHT_PANEL_KEY = 'llm3d:right-panel';

function EmptyWorkspace() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Empty className="max-w-md border-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BoxIcon />
          </EmptyMedia>
          <EmptyTitle>选择或创建一个项目</EmptyTitle>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <Empty className="border-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareIcon />
          </EmptyMedia>
          <EmptyTitle>选择一个对话</EmptyTitle>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

function ComposerDock({ mobile }: { mobile: boolean }) {
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  if (!selectedProjectId) return null;
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 z-20 flex justify-center px-3',
        mobile ? 'bottom-4' : 'bottom-5',
      )}
    >
      <div className="pointer-events-auto w-full max-w-xl">
        <Composer showProgress={mobile} />
      </div>
    </div>
  );
}

export function Workspace() {
  const isDesktop = useIsDesktop();
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const project = useAppStore((state) =>
    state.selectedProjectId ? state.projectStates[state.selectedProjectId] : undefined,
  );
  const [rightOpen, setRightOpen] = useState(
    () => window.localStorage.getItem(RIGHT_PANEL_KEY) !== 'closed',
  );
  const [chatSheetOpen, setChatSheetOpen] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(RIGHT_PANEL_KEY, rightOpen ? 'open' : 'closed');
  }, [rightOpen]);

  const ready = Boolean(selectedProjectId && project);

  return (
    <SidebarProvider className="h-svh min-h-0">
      <AppSidebar />
      <SidebarInset className="relative min-h-0 overflow-hidden">
        <TopBar
          rightPanelOpen={rightOpen}
          onToggleRightPanel={() => setRightOpen((value) => !value)}
          onOpenChat={() => setChatSheetOpen(true)}
        />

        {!ready ? (
          <EmptyWorkspace />
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {isDesktop ? (
                <Tabs defaultValue="preview" className="min-h-0 flex-1 gap-0">
                  <div className="flex items-center border-b px-3 py-2">
                    <TabsList>
                      <TabsTrigger value="preview">
                        <BoxIcon data-icon="inline-start" />
                        预览
                      </TabsTrigger>
                      <TabsTrigger value="operations">
                        <LayersIcon data-icon="inline-start" />
                        操作
                      </TabsTrigger>
                      <TabsTrigger value="artifacts">
                        <PackageIcon data-icon="inline-start" />
                        产物
                      </TabsTrigger>
                    </TabsList>
                  </div>
                  <TabsContent
                    value="preview"
                    forceMount
                    className="min-h-0 flex-1 data-[state=inactive]:hidden"
                  >
                    <PreviewPanel projectId={selectedProjectId!} />
                  </TabsContent>
                  <TabsContent
                    value="operations"
                    forceMount
                    className="min-h-0 flex-1 data-[state=inactive]:hidden"
                  >
                    <OperationsPanel projectId={selectedProjectId!} />
                  </TabsContent>
                  <TabsContent
                    value="artifacts"
                    forceMount
                    className="min-h-0 flex-1 data-[state=inactive]:hidden"
                  >
                    <ArtifactsPanel projectId={selectedProjectId!} />
                  </TabsContent>
                </Tabs>
              ) : (
                <PreviewPanel projectId={selectedProjectId!} />
              )}
            </div>

            {isDesktop && rightOpen ? (
              <div className="flex w-[400px] shrink-0 flex-col border-l">
                {activeConversationId ? (
                  <Tabs defaultValue="chat" className="min-h-0 flex-1 gap-0">
                    <div className="flex items-center gap-2 border-b px-3 py-2">
                      <TabsList>
                        <TabsTrigger value="chat">
                          <MessageSquareIcon data-icon="inline-start" />
                          对话
                        </TabsTrigger>
                        <TabsTrigger value="progress">
                          <ListTreeIcon data-icon="inline-start" />
                          进度
                        </TabsTrigger>
                      </TabsList>
                      <div className="ml-auto flex items-center gap-1">
                        <ModelSwitchButton
                          conversationId={activeConversationId}
                          className="max-w-[190px]"
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setRightOpen(false)}
                        >
                          <PanelRightCloseIcon />
                        </Button>
                      </div>
                    </div>
                    <TabsContent
                      value="chat"
                      forceMount
                      className="min-h-0 flex-1 data-[state=inactive]:hidden"
                    >
                      <ChatPanel conversationId={activeConversationId} />
                    </TabsContent>
                    <TabsContent
                      value="progress"
                      forceMount
                      className="min-h-0 flex-1 data-[state=inactive]:hidden"
                    >
                      <ProgressPanel
                        conversationId={activeConversationId}
                        projectId={selectedProjectId!}
                      />
                    </TabsContent>
                  </Tabs>
                ) : (
                  <EmptyConversation />
                )}
              </div>
            ) : null}
          </div>
        )}

        {ready ? <ComposerDock mobile={!isDesktop} /> : null}
      </SidebarInset>

      <Sheet open={chatSheetOpen} onOpenChange={setChatSheetOpen}>
        <SheetContent side="bottom" showCloseButton={false} className="flex h-[85svh] flex-col gap-0 p-0">
          <SheetHeader className="flex-row items-center gap-2 border-b p-3">
            <SheetTitle className="text-sm">对话</SheetTitle>
            <div className="ml-auto flex items-center gap-1">
              <ModelSwitchButton conversationId={activeConversationId} className="max-w-[180px]" />
              <SheetClose asChild>
                <Button variant="ghost" size="icon-sm">
                  <XIcon />
                </Button>
              </SheetClose>
            </div>
          </SheetHeader>
          {selectedProjectId ? (
            <Tabs defaultValue="chat" className="min-h-0 flex-1 gap-0">
              <div className="border-b px-3 py-2">
                <TabsList>
                  <TabsTrigger value="chat">
                    <MessageSquareIcon data-icon="inline-start" />
                    对话
                  </TabsTrigger>
                  <TabsTrigger value="progress">
                    <ListTreeIcon data-icon="inline-start" />
                    进度
                  </TabsTrigger>
                  <TabsTrigger value="artifacts">
                    <PackageIcon data-icon="inline-start" />
                    产物
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="chat" className="min-h-0 flex-1">
                {activeConversationId ? (
                  <ChatPanel conversationId={activeConversationId} />
                ) : (
                  <EmptyConversation />
                )}
              </TabsContent>
              <TabsContent value="progress" className="min-h-0 flex-1">
                {activeConversationId ? (
                  <ProgressPanel
                    conversationId={activeConversationId}
                    projectId={selectedProjectId}
                  />
                ) : (
                  <EmptyConversation />
                )}
              </TabsContent>
              <TabsContent value="artifacts" className="min-h-0 flex-1">
                <ArtifactsPanel projectId={selectedProjectId} />
              </TabsContent>
            </Tabs>
          ) : (
            <EmptyConversation />
          )}
        </SheetContent>
      </Sheet>
    </SidebarProvider>
  );
}
