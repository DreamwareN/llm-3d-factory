import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeftIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ProviderProfileRecord } from '@llm3d/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useAppStore } from '@/stores/useAppStore';

interface ProviderFormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

const EMPTY_FORM: ProviderFormState = {
  name: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  defaultModel: 'gpt-4.1-mini',
};

function ProviderDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: ProviderProfileRecord | null;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState<ProviderFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name,
        baseUrl: editing.baseUrl,
        apiKey: '',
        defaultModel: editing.defaultModel,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, editing]);

  const submit = async () => {
    setSaving(true);
    try {
      if (editing) {
        await api.providers.update(editing.id, {
          name: form.name,
          baseUrl: form.baseUrl,
          defaultModel: form.defaultModel,
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        });
      } else {
        await api.providers.create(form);
      }
      await onSaved();
      toast.success(editing ? 'Provider 已更新' : 'Provider 已创建');
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑 Provider' : '新增 Provider'}</DialogTitle>
          <DialogDescription>
            支持任何 OpenAI 兼容接口：OpenAI、DeepSeek、OpenRouter、Ollama、vLLM 等。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="provider-name">名称</FieldLabel>
            <Input
              id="provider-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="例如：DeepSeek"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-base">Base URL</FieldLabel>
            <Input
              id="provider-base"
              value={form.baseUrl}
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              placeholder="https://api.deepseek.com/v1"
            />
            <FieldDescription>需包含 /v1 前缀（若服务商要求）。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-key">API Key</FieldLabel>
            <Input
              id="provider-key"
              type="password"
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              placeholder={editing?.hasApiKey ? '已保存，留空保持不变' : 'sk-…'}
            />
            <FieldDescription>仅保存在本地服务端，不会返回给浏览器。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="provider-model">默认模型</FieldLabel>
            <Input
              id="provider-model"
              value={form.defaultModel}
              onChange={(event) => setForm({ ...form, defaultModel: event.target.value })}
              placeholder="deepseek-chat"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={saving || !form.name.trim() || !form.baseUrl.trim()}
            onClick={() => void submit()}
          >
            {saving ? <Spinner data-icon="inline-start" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SettingsPage() {
  const providers = useAppStore((state) => state.providers);
  const refreshProviders = useAppStore((state) => state.refreshProviders);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderProfileRecord | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderProfileRecord | null>(null);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const test = async (provider: ProviderProfileRecord) => {
    setTesting(provider.id);
    try {
      const result = await api.providers.test(provider.id);
      toast.success(`连接成功，发现 ${result.modelCount} 个模型`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (provider: ProviderProfileRecord) => {
    await api.providers.remove(provider.id);
    await refreshProviders();
    toast.success('已删除');
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/" aria-label="返回">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">设置</h1>
          <p className="text-sm text-muted-foreground">请使用支持视觉的模型。</p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <PlusIcon data-icon="inline-start" />
          新增 Provider
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {providers.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>还没有 Provider</CardTitle>
              <CardDescription>
                本地 Ollama 的 Base URL 通常为 http://localhost:11434/v1。
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          providers.map((provider) => (
            <Card key={provider.id}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base">{provider.name}</CardTitle>
                  {provider.hasApiKey ? (
                    <Badge variant="outline" className="text-emerald-400">
                      已配置 Key
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-amber-400">
                      无 Key
                    </Badge>
                  )}
                </div>
                <CardDescription className="font-mono text-xs">
                  {provider.baseUrl}
                  {provider.defaultModel ? ` · ${provider.defaultModel}` : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={testing === provider.id}
                  onClick={() => void test(provider)}
                >
                  {testing === provider.id ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <PlugZapIcon data-icon="inline-start" />
                  )}
                  测试连接
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(provider);
                    setDialogOpen(true);
                  }}
                >
                  <PencilIcon data-icon="inline-start" />
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setPendingDelete(provider)}
                >
                  <Trash2Icon data-icon="inline-start" />
                  删除
                </Button>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <ProviderDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={refreshProviders}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={`删除 Provider「${pendingDelete?.name ?? ''}」？`}
        description="删除后不可恢复，引用它的对话将无法继续生成。"
        onConfirm={async () => {
          if (pendingDelete) await remove(pendingDelete);
        }}
      />
    </div>
  );
}
