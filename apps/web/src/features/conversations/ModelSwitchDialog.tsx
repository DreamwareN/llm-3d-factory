import { useEffect, useMemo, useState } from 'react';
import { Loader2Icon, ShuffleIcon } from 'lucide-react';
import type { ConversationRecord } from '@llm3d/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/useAppStore';

interface ModelSwitchDialogProps {
  conversation: ConversationRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ModelSwitchDialog({ conversation, open, onOpenChange }: ModelSwitchDialogProps) {
  const providers = useAppStore((state) => state.providers);
  const updateConversation = useAppStore((state) => state.updateConversation);

  const [providerId, setProviderId] = useState(conversation.providerProfileId);
  const [model, setModel] = useState(conversation.model);
  const [resetContext, setResetContext] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProviderId(conversation.providerProfileId);
    setModel(conversation.model);
    setResetContext(false);
  }, [open, conversation.providerProfileId, conversation.model]);

  useEffect(() => {
    if (!providerId) return;
    api.providers
      .models(providerId)
      .then((result) => setModels(result.models))
      .catch(() => setModels([]));
  }, [providerId]);

  const changed = useMemo(
    () => providerId !== conversation.providerProfileId || model.trim() !== conversation.model,
    [providerId, model, conversation.providerProfileId, conversation.model],
  );

  const submit = async () => {
    if (!model.trim() || !changed || submitting) return;
    setSubmitting(true);
    try {
      const ok = await updateConversation(conversation.id, {
        providerProfileId: providerId,
        model: model.trim(),
        resetContext,
      });
      if (ok) onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>切换模型</DialogTitle>
          <DialogDescription>请选择如何处理已有上下文。</DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel>Provider</FieldLabel>
            <Select
              value={providerId}
              onValueChange={(value) => {
                setProviderId(value);
                setModel('');
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择 Provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="switch-model">模型</FieldLabel>
            <Input
              id="switch-model"
              list="switch-provider-models"
              placeholder="模型 ID"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="switch-provider-models">
              {models.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
          </Field>

          <Field>
            <FieldLabel>上下文处理</FieldLabel>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setResetContext(false)}
                className={cn(
                  'rounded-md border p-3 text-left text-sm transition-colors',
                  !resetContext ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                )}
              >
                <div className="font-medium">保留上下文</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  新模型记得之前做过什么
                </div>
              </button>
              <button
                type="button"
                onClick={() => setResetContext(true)}
                className={cn(
                  'rounded-md border p-3 text-left text-sm transition-colors',
                  resetContext ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                )}
              >
                <div className="font-medium">清空上下文</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  保留聊天记录，从当前场景重新开始
                </div>
              </button>
            </div>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!changed || !model.trim() || submitting} onClick={() => void submit()}>
            {submitting ? (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : (
              <ShuffleIcon data-icon="inline-start" />
            )}
            切换
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
