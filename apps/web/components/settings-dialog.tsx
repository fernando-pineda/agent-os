'use client';

import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useModelsFeed } from '@/components/agent-context';
import { ModelPickerModal } from '@/components/model-picker-modal';
import { RemindersEditor } from '@/components/reminders-editor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Tabs,
  TabsIndicator,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@/components/ui/tabs';
import {
  createMcpServer,
  deleteMcpServer,
  getConfig,
  getMcpServers,
  getMcpStatuses,
  updateConfig,
  updateMcpServer,
} from '@/lib/api';
import type { McpServerConfig, McpStatus } from '@/lib/types';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { models } = useModelsFeed();

  const [defaultModel, setDefaultModel] = useState('');
  const [reminders, setReminders] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState('');
  const [saved, setSaved] = useState(false);

  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [statuses, setStatuses] = useState<Record<string, McpStatus>>({});
  const [statusesLoading, setStatusesLoading] = useState(false);
  const [mcpError, setMcpError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<McpServerConfig | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const refreshServers = useCallback(async () => {
    try {
      const list = await getMcpServers();
      setServers(list);
    } catch (err) {
      setMcpError(
        err instanceof Error ? err.message : 'Failed to load servers',
      );
    }
  }, []);

  const refreshStatuses = useCallback(async () => {
    setStatusesLoading(true);
    try {
      const res = await getMcpStatuses();
      setStatuses(res.statuses);
    } catch (err) {
      setMcpError(
        err instanceof Error ? err.message : 'Failed to load server statuses',
      );
    } finally {
      setStatusesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setConfigError('');
    setSaved(false);
    setMcpError('');
    getConfig()
      .then((cfg) => {
        setDefaultModel(cfg.defaultModel ?? '');
        setReminders(cfg.reminders ?? []);
      })
      .catch((err) => {
        setConfigError(
          err instanceof Error ? err.message : 'Failed to load config',
        );
      });
    void refreshServers();
    void refreshStatuses();
  }, [open, refreshServers, refreshStatuses]);

  const onSaveConfig = useCallback(async () => {
    setSaving(true);
    setConfigError('');
    setSaved(false);
    try {
      const payload: {
        defaultModel?: string;
        reminders?: string[];
      } = {};
      if (defaultModel.trim()) payload.defaultModel = defaultModel.trim();
      payload.reminders = reminders;
      const updated = await updateConfig(payload);
      setReminders(updated.reminders ?? []);
      setSaved(true);
    } catch (err) {
      setConfigError(
        err instanceof Error ? err.message : 'Failed to save config',
      );
    } finally {
      setSaving(false);
    }
  }, [defaultModel, reminders]);

  const openNewForm = useCallback(() => {
    setEditingServer(null);
    setFormOpen(true);
  }, []);

  const openEditForm = useCallback((server: McpServerConfig) => {
    setEditingServer(server);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingServer(null);
  }, []);

  const openDeleteDialog = useCallback((server: McpServerConfig) => {
    setDeleteTarget(server);
    setDeleteError('');
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setDeleteTarget(null);
    setDeleteError('');
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteMcpServer(deleteTarget.name);
      closeDeleteDialog();
      void refreshServers();
      void refreshStatuses();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : 'Failed to delete server',
      );
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, closeDeleteDialog, refreshServers, refreshStatuses]);

  const onFormSubmit = useCallback(async () => {
    void refreshServers();
    void refreshStatuses();
    closeForm();
  }, [refreshServers, refreshStatuses, closeForm]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Configure defaults and plugins.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general">
          <TabsList>
            <TabsTab value="general">General</TabsTab>
            <TabsTab value="plugins">Plugins</TabsTab>
            <TabsTab value="reminders">Reminders</TabsTab>
            <TabsIndicator />
          </TabsList>

          <TabsPanel value="general">
            <div className="space-y-3 overflow-y-auto py-2 pr-1">
              <div>
                <ModelPickerModal
                  models={models}
                  value={defaultModel}
                  onChange={setDefaultModel}
                  loading={models.length === 0}
                  allowManual={models.length === 0}
                  placeholder="Select a model"
                  label="Default model"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  Used for new agents and any agent without its own model.
                </p>
              </div>
            </div>

            {configError && (
              <div className="px-1 pb-2 text-xs text-destructive">
                {configError}
              </div>
            )}
            {saved && (
              <div className="px-1 pb-2 text-xs text-emerald-400">
                Settings saved. Changes apply to agents started after saving.
                Restart running agents to apply.
              </div>
            )}
            <Button
              onClick={onSaveConfig}
              disabled={saving}
              className="mt-2 w-full"
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </TabsPanel>

          <TabsPanel value="plugins">
            <div className="space-y-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-400">Servers</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs text-zinc-300"
                  onClick={openNewForm}
                >
                  + New
                </Button>
              </div>

              {mcpError && (
                <div className="text-xs text-destructive">{mcpError}</div>
              )}

              {servers.length === 0 ? (
                <div className="py-4 text-center text-sm text-zinc-500">
                  No plugins yet.
                </div>
              ) : (
                <div className="max-h-[40vh] space-y-1 overflow-y-auto pr-1">
                  {servers.map((server) => {
                    const status = statusesLoading
                      ? 'unknown'
                      : (statuses[server.name] ?? 'unknown');
                    return (
                      <div
                        key={server.name}
                        className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm text-zinc-100">
                            <span
                              className={`size-2.5 rounded-full ring-2 ring-zinc-900 ${mcpStatusColor(status)}`}
                              title={status}
                            />
                            {server.name}
                          </div>
                          <div className="truncate font-mono text-xs text-zinc-500">
                            {serverDescriptor(server)}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-zinc-400 hover:text-zinc-100"
                            onClick={() => openEditForm(server)}
                          >
                            <PencilIcon />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-zinc-400 hover:text-red-400"
                            onClick={() => openDeleteDialog(server)}
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsPanel>

          <TabsPanel value="reminders">
            <div className="space-y-3 py-2">
              <p className="text-xs text-zinc-500">
                Short texts injected into every agent turn. Agents consider them
                silently.
              </p>
              <RemindersEditor
                value={reminders}
                onChange={setReminders}
                idPrefix="global-reminders"
              />
              <p className="text-xs text-zinc-500">
                Applies from the next turn.
              </p>
            </div>
          </TabsPanel>
        </Tabs>
      </DialogContent>

      <McpServerForm
        open={formOpen}
        onOpenChange={(v) => {
          if (!v) closeForm();
          else setFormOpen(v);
        }}
        editing={editingServer}
        onSubmitted={onFormSubmit}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) closeDeleteDialog();
        }}
      >
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}</DialogTitle>
            <DialogDescription className="text-zinc-400">
              This will permanently remove this server from the configuration.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {deleteError && (
              <div className="text-xs text-destructive">{deleteError}</div>
            )}
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
              className="w-full"
            >
              {deleting ? 'Deleting...' : 'Delete server'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function serverDescriptor(server: McpServerConfig): string {
  if (server.transport === 'http') {
    return server.url ?? '';
  }
  const parts = [server.command ?? '', ...(server.args ?? [])];
  return parts.join(' ');
}

function mcpStatusColor(status: McpStatus): string {
  switch (status) {
    case 'online':
      return 'bg-emerald-400';
    case 'offline':
      return 'bg-red-400';
    default:
      return 'bg-zinc-500';
  }
}

interface McpServerFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: McpServerConfig | null;
  onSubmitted: () => void;
}

function McpServerForm({
  open,
  onOpenChange,
  editing,
  onSubmitted,
}: McpServerFormProps) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    if (editing) {
      setName(editing.name);
      setTransport(editing.transport);
      setCommand(editing.command ?? '');
      setArgs((editing.args ?? []).join(' '));
      setEnv(
        Object.entries(editing.env ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
      );
      setUrl(editing.url ?? '');
      setHeaders(
        Object.entries(editing.headers ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
      );
    } else {
      setName('');
      setTransport('stdio');
      setCommand('');
      setArgs('');
      setEnv('');
      setUrl('');
      setHeaders('');
    }
  }, [open, editing]);

  const onSubmit = useCallback(async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload: McpServerConfig = {
        name: name.trim(),
        transport,
      };
      if (transport === 'stdio') {
        if (!command.trim()) {
          setError('Command is required for stdio transport');
          setSaving(false);
          return;
        }
        payload.command = command.trim();
        const parsedArgs = args.split(/\s+/).filter((s) => s.length > 0);
        if (parsedArgs.length > 0) payload.args = parsedArgs;
        const parsedEnv: Record<string, string> = {};
        for (const line of env.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).trim();
            const v = trimmed.slice(eqIdx + 1).trim();
            if (k) parsedEnv[k] = v;
          }
        }
        if (Object.keys(parsedEnv).length > 0) payload.env = parsedEnv;
      } else {
        if (!url.trim()) {
          setError('URL is required for http transport');
          setSaving(false);
          return;
        }
        payload.url = url.trim();
        const parsedHeaders: Record<string, string> = {};
        for (const line of headers.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).trim();
            const v = trimmed.slice(eqIdx + 1).trim();
            if (k) parsedHeaders[k] = v;
          }
        }
        if (Object.keys(parsedHeaders).length > 0)
          payload.headers = parsedHeaders;
      }

      if (editing) {
        await updateMcpServer(editing.name, payload);
      } else {
        await createMcpServer(payload);
      }
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save server');
    } finally {
      setSaving(false);
    }
  }, [name, transport, command, args, env, url, headers, editing, onSubmitted]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit server' : 'New server'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto py-2 pr-1">
          <div>
            <label className="mb-1 block text-xs text-zinc-400">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="filesystem"
              className="border-zinc-800 bg-zinc-950 text-zinc-100"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-zinc-400">
              Transport
            </label>
            <div className="flex gap-2">
              {(['stdio', 'http'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTransport(t)}
                  className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                    transport === t
                      ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
                      : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {transport === 'stdio' ? (
            <>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">
                  Command
                </label>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Args</label>
                <Input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  Space-separated arguments.
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Env</label>
                <textarea
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  placeholder={'API_KEY=secret\nNODE_ENV=production'}
                  rows={4}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-700"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  One KEY=VALUE per line.
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">URL</label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://localhost:3001/mcp"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">
                  Headers
                </label>
                <textarea
                  value={headers}
                  onChange={(e) => setHeaders(e.target.value)}
                  placeholder={'Authorization=Bearer token\nX-API-Key=secret'}
                  rows={4}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-700"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  One KEY=VALUE per line.
                </p>
              </div>
            </>
          )}
        </div>

        {error && (
          <div className="px-1 pb-2 text-xs text-destructive">{error}</div>
        )}
        <Button onClick={onSubmit} disabled={saving} className="mt-2 w-full">
          {saving ? 'Saving...' : editing ? 'Save changes' : 'Create server'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
