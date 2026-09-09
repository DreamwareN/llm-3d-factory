import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BoxIcon,
  ChevronRightIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/useAppStore';
import { StatusDot } from './ConversationStatusBadge';

const EXPANDED_STORAGE_KEY = 'llm3d:expanded-projects';

function readExpandedProjects(): Set<string> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function AppSidebar() {
  const projects = useAppStore((state) => state.projects);
  const providers = useAppStore((state) => state.providers);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const projectStates = useAppStore((state) => state.projectStates);
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const selectProject = useAppStore((state) => state.selectProject);
  const selectConversation = useAppStore((state) => state.selectConversation);
  const createConversation = useAppStore((state) => state.createConversation);
  const deleteConversation = useAppStore((state) => state.deleteConversation);
  const createProject = useAppStore((state) => state.createProject);
  const deleteProject = useAppStore((state) => state.deleteProject);

  const { isMobile, setOpenMobile } = useSidebar();

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'project' | 'conversation'; id: string; title: string } | null
  >(null);
  const [expanded, setExpanded] = useState<Set<string>>(readExpandedProjects);

  useEffect(() => {
    if (!selectedProjectId) return;
    setExpanded((current) => {
      if (current.has(selectedProjectId)) return current;
      const next = new Set(current);
      next.add(selectedProjectId);
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expanded]));
  }, [expanded]);

  const toggleProject = (projectId: string, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  };

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt - a.updatedAt),
    [projects],
  );

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <div className="flex h-8 items-center px-2">
          <span className="truncate text-sm font-semibold">LLM 3D Factory</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>项目</SidebarGroupLabel>
          <SidebarGroupAction title="新建项目" onClick={() => setProjectDialogOpen(true)}>
            <PlusIcon />
            <span className="sr-only">新建项目</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            {sortedProjects.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">还没有项目</p>
            ) : (
              <SidebarMenu>
                {sortedProjects.map((project) => {
                  const projectState = projectStates[project.id];
                  const conversations = Object.values(projectState?.conversations ?? {}).sort(
                    (a, b) => b.conversation.updatedAt - a.conversation.updatedAt,
                  );
                  const open = expanded.has(project.id);
                  return (
                    <Collapsible
                      key={project.id}
                      asChild
                      open={open}
                      onOpenChange={(next) => toggleProject(project.id, next)}
                      className="group/collapsible"
                    >
                      <SidebarMenuItem>
                        <CollapsibleTrigger asChild>
                          <SidebarMenuButton
                            isActive={project.id === selectedProjectId}
                            tooltip={project.name}
                            onClick={() => {
                              if (project.id !== selectedProjectId) selectProject(project.id);
                            }}
                          >
                            <BoxIcon />
                            <span>{project.name}</span>
                            <ChevronRightIcon
                              className={cn(
                                'ml-auto transition-transform duration-200',
                                'group-data-[state=open]/collapsible:rotate-90',
                              )}
                            />
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                        <SidebarMenuAction
                          title="删除项目"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete({
                              kind: 'project',
                              id: project.id,
                              title: project.name,
                            });
                          }}
                        >
                          <Trash2Icon />
                          <span className="sr-only">删除项目</span>
                        </SidebarMenuAction>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {conversations.map(({ conversation }) => (
                              <SidebarMenuSubItem key={conversation.id}>
                                <SidebarMenuSubButton
                                  asChild
                                  isActive={conversation.id === activeConversationId}
                                  className="w-full pr-7"
                                >
                                  <button
                                    type="button"
                                    title={conversation.title}
                                    onClick={() => {
                                      selectConversation(conversation.id);
                                      if (isMobile) setOpenMobile(false);
                                    }}
                                  >
                                    <span className="flex size-4 shrink-0 items-center justify-center">
                                      <StatusDot status={conversation.status} />
                                    </span>
                                    <span>{conversation.title}</span>
                                  </button>
                                </SidebarMenuSubButton>
                                <SidebarMenuAction
                                  title="删除对话"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setPendingDelete({
                                      kind: 'conversation',
                                      id: conversation.id,
                                      title: conversation.title,
                                    });
                                  }}
                                >
                                  <Trash2Icon />
                                  <span className="sr-only">删除对话</span>
                                </SidebarMenuAction>
                              </SidebarMenuSubItem>
                            ))}
                            <SidebarMenuSubItem>
                              <SidebarMenuSubButton asChild className="w-full">
                                <button
                                  type="button"
                                  disabled={providers.length === 0}
                                  title={
                                    providers.length === 0
                                      ? '请先在「设置」添加 Provider'
                                      : '新建对话'
                                  }
                                  onClick={() => void createConversation(project.id)}
                                >
                                  <PlusIcon />
                                  <span>新建对话</span>
                                </button>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  );
                })}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="设置">
              <Link to="/settings">
                <SettingsIcon />
                <span>设置</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />

      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="例如：低多边形城市"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && projectName.trim()) {
                void createProject(projectName.trim()).then(() => {
                  setProjectName('');
                  setProjectDialogOpen(false);
                });
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setProjectDialogOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!projectName.trim()}
              onClick={() => {
                void createProject(projectName.trim()).then(() => {
                  setProjectName('');
                  setProjectDialogOpen(false);
                });
              }}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={
          pendingDelete?.kind === 'project'
            ? `删除项目「${pendingDelete.title}」？`
            : `删除对话「${pendingDelete?.title ?? ''}」？`
        }
        description="删除后不可恢复。"
        onConfirm={async () => {
          if (!pendingDelete) return;
          if (pendingDelete.kind === 'project') await deleteProject(pendingDelete.id);
          else await deleteConversation(pendingDelete.id);
        }}
      />
    </Sidebar>
  );
}
