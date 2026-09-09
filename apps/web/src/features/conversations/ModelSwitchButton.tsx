import { useState } from 'react';
import { ShuffleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isGenerating, useAppStore } from '@/stores/useAppStore';
import { ModelSwitchDialog } from './ModelSwitchDialog';

export function ModelSwitchButton({
  conversationId,
  className,
}: {
  conversationId: string | null;
  className?: string;
}) {
  const runtime = useAppStore((state) => {
    if (!conversationId) return undefined;
    for (const project of Object.values(state.projectStates)) {
      const entry = project.conversations[conversationId];
      if (entry) return entry;
    }
    return undefined;
  });
  const providers = useAppStore((state) => state.providers);
  const [open, setOpen] = useState(false);

  if (!runtime) return null;

  const provider = providers.find(
    (entry) => entry.id === runtime.conversation.providerProfileId,
  );

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className={className}
        disabled={isGenerating(runtime.conversation.status)}
        onClick={() => setOpen(true)}
      >
        <ShuffleIcon data-icon="inline-start" />
        <span className="max-w-[150px] truncate">
          {provider?.name ?? '模型'} · {runtime.conversation.model}
        </span>
      </Button>
      <ModelSwitchDialog
        conversation={runtime.conversation}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
