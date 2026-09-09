import { useEffect, useRef, useState } from 'react';
import { SendIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TurnProgress } from '@/features/progress/TurnProgress';
import { isGenerating, useAppStore } from '@/stores/useAppStore';

export function Composer({ showProgress = false }: { showProgress?: boolean }) {
  const activeConversationId = useAppStore((state) => state.activeConversationId);
  const runtime = useAppStore((state) => {
    if (!state.activeConversationId) return undefined;
    for (const project of Object.values(state.projectStates)) {
      const entry = project.conversations[state.activeConversationId];
      if (entry) return entry;
    }
    return undefined;
  });
  const sendUserMessage = useAppStore((state) => state.sendUserMessage);

  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const streaming = runtime ? isGenerating(runtime.conversation.status) : false;
  const disabled = !runtime || streaming;

  useEffect(() => {
    setDraft('');
  }, [activeConversationId]);

  const send = () => {
    const text = draft.trim();
    if (!text || disabled || !activeConversationId) return;
    sendUserMessage(activeConversationId, text);
    setDraft('');
  };

  const placeholder = !runtime
    ? '请先新建或选择一个对话'
    : streaming
      ? '模型正在生成…'
      : '输入消息，Enter 发送';

  return (
    <div className="flex flex-col gap-2">
      {showProgress ? <TurnProgress conversationId={activeConversationId} /> : null}
      <div className="flex items-end gap-2 rounded-3xl border bg-background/85 p-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <Textarea
          ref={textareaRef}
          rows={2}
          placeholder={placeholder}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          className="max-h-40 min-h-[52px] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <Button size="icon" disabled={disabled || !draft.trim()} onClick={send}>
          <SendIcon />
        </Button>
      </div>
    </div>
  );
}
