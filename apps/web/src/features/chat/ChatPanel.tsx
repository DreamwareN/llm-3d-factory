import { useState } from 'react';
import { BotIcon, BrainIcon, ChevronRightIcon, UserIcon } from 'lucide-react';
import type { MessagePart, MessageRecord } from '@llm3d/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Message, MessageAvatar, MessageContent } from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Spinner } from '@/components/ui/spinner';
import { useIsDesktop } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/useAppStore';
import { ToolCallCard } from './ToolCallCard';

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <BrainIcon className="size-3.5" />
        推理过程
        <ChevronRightIcon
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 whitespace-pre-wrap rounded-md border border-dashed bg-muted/40 p-2 text-xs text-muted-foreground">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function MessageParts({ parts }: { parts: MessagePart[] }) {
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === 'text') {
          return (
            <div
              key={`text-${index}`}
              className="whitespace-pre-wrap text-sm leading-relaxed"
            >
              {part.text}
            </div>
          );
        }
        if (part.type === 'reasoning') {
          return <ReasoningBlock key={`reasoning-${index}`} text={part.text} />;
        }
        if (part.type === 'tool-call') {
          return <ToolCallCard key={part.callId} part={part} />;
        }
        return (
          <Alert key={`error-${index}`} variant="destructive">
            <AlertDescription>{part.message}</AlertDescription>
          </Alert>
        );
      })}
    </>
  );
}

function ChatMessage({ message }: { message: MessageRecord }) {
  const isUser = message.role === 'user';
  const isEmpty = message.parts.length === 0;
  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageAvatar>
        {isUser ? <UserIcon className="size-4" /> : <BotIcon className="size-4" />}
      </MessageAvatar>
      <MessageContent>
        {isEmpty ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            思考中…
          </div>
        ) : (
          <MessageParts parts={message.parts} />
        )}
      </MessageContent>
    </Message>
  );
}

export function ChatPanel({ conversationId }: { conversationId: string }) {
  const isDesktop = useIsDesktop();
  const runtime = useAppStore((state) => {
    for (const project of Object.values(state.projectStates)) {
      const entry = project.conversations[conversationId];
      if (entry) return entry;
    }
    return undefined;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent
              className={cn('gap-5 px-4 pt-4', isDesktop ? 'pb-52' : 'pb-6')}
            >
              {(runtime?.messages ?? []).map((message) => (
                <MessageScrollerItem key={message.id}>
                  <ChatMessage message={message} />
                </MessageScrollerItem>
              ))}
              <MessageScrollerItem className="h-px" />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  );
}
