'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAgentsFeed, useModelsFeed } from '@/components/agent-context';
import { ModelPickerModal } from '@/components/model-picker-modal';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Tabs,
  TabsIndicator,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@/components/ui/tabs';
import {
  getConfig,
  getPlugins,
  startAgent,
  stopAgent,
  updateAgent,
  updateConfig,
} from '@/lib/api';
import type { AgentInfo, GlobalConfigStatus, PluginInfo } from '@/lib/types';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function isRunning(agent: AgentInfo): boolean {
  return (
    agent.status === 'running' ||
    agent.status === 'online' ||
    agent.status === 'busy'
  );
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const agents = useAgentsFeed();
  const { models } = useModelsFeed();

  const [config, setConfig] = useState<GlobalConfigStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [saved, setSaved] = useState(false);

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginErrors, setPluginErrors] = useState<Record<string, string>>({});
  const [restarting, setRestarting] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setProviderError('');
    setSaved(false);
    getConfig()
      .then((cfg) => {
        setConfig(cfg);
        setDefaultModel(cfg.defaultModel);
      })
      .catch((err) => {
        setProviderError(
          err instanceof Error ? err.message : 'Failed to load config',
        );
      });
    getPlugins()
      .then((data) => setPlugins(data))
      .catch(console.error);
  }, [open]);

  const onSaveConfig = useCallback(async () => {
    setSaving(true);
    setProviderError('');
    setSaved(false);
    try {
      const payload: { apiKey?: string; defaultModel?: string } = {};
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      if (defaultModel.trim()) payload.defaultModel = defaultModel.trim();
      const updated = await updateConfig(payload);
      setConfig(updated);
      setApiKey('');
      setSaved(true);
    } catch (err) {
      setProviderError(
        err instanceof Error ? err.message : 'Failed to save config',
      );
    } finally {
      setSaving(false);
    }
  }, [apiKey, defaultModel]);

  const isPluginEnabled = useCallback(
    (agent: AgentInfo, pluginName: string): boolean => {
      if (!agent.plugins) return true;
      return agent.plugins.includes(pluginName);
    },
    [],
  );

  const onTogglePlugin = useCallback(
    async (agent: AgentInfo, pluginName: string, enabled: boolean) => {
      const current = agent.plugins
        ? new Set(agent.plugins)
        : new Set(plugins.map((p) => p.name));
      if (enabled) {
        current.add(pluginName);
      } else {
        current.delete(pluginName);
      }
      const next = [...current];
      setPluginErrors((prev) => {
        const copy = { ...prev };
        delete copy[agent.id];
        return copy;
      });
      try {
        await updateAgent(agent.id, { plugins: next });
        if (isRunning(agent)) {
          setRestarting((prev) => ({ ...prev, [agent.id]: true }));
          try {
            await stopAgent(agent.id);
            await startAgent(agent.id);
          } finally {
            setRestarting((prev) => {
              const copy = { ...prev };
              delete copy[agent.id];
              return copy;
            });
          }
        }
      } catch (err) {
        setPluginErrors((prev) => ({
          ...prev,
          [agent.id]: err instanceof Error ? err.message : 'Update failed',
        }));
      }
    },
    [plugins],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Configure the provider and plugins.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="provider">
          <TabsList>
            <TabsTab value="provider">Provider</TabsTab>
            <TabsTab value="plugins">Plugins</TabsTab>
            <TabsIndicator />
          </TabsList>

          <TabsPanel value="provider">
            <div className="space-y-3 overflow-y-auto py-2 pr-1">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">
                  Provider
                </label>
                <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-300">
                  fireworks
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs text-zinc-400">
                  API key
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={config ? config.apiKey : 'fw-...'}
                  className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
                />
                <p className="mt-1 text-xs text-zinc-500">
                  Leave empty to keep the current key.
                </p>
              </div>

              <ModelPickerModal
                models={models}
                value={defaultModel}
                onChange={setDefaultModel}
                loading={models.length === 0}
                allowManual={models.length === 0}
                placeholder="Select a model"
              />
            </div>

            {providerError && (
              <div className="px-1 pb-2 text-xs text-destructive">
                {providerError}
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
            <div className="space-y-4 overflow-y-auto py-2 pr-1">
              {agents.length === 0 ? (
                <div className="py-4 text-center text-sm text-zinc-500">
                  No agents yet.
                </div>
              ) : (
                agents.map((agent) => {
                  const restartingAgent = restarting[agent.id] ?? false;
                  return (
                    <div key={agent.id} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-zinc-100">
                          {agent.name}
                        </span>
                        {restartingAgent && (
                          <span className="text-xs text-zinc-500">
                            Restarting...
                          </span>
                        )}
                      </div>
                      {pluginErrors[agent.id] && (
                        <div className="text-xs text-destructive">
                          {pluginErrors[agent.id]}
                        </div>
                      )}
                      <div className="space-y-2">
                        {plugins.map((plugin) => (
                          <div
                            key={plugin.name}
                            className="flex items-start justify-between gap-3"
                          >
                            <div className="min-w-0">
                              <div className="font-mono text-xs text-zinc-300">
                                {plugin.name}
                              </div>
                              <div className="text-xs text-zinc-500">
                                {plugin.description}
                              </div>
                            </div>
                            <Switch
                              checked={isPluginEnabled(agent, plugin.name)}
                              onCheckedChange={(checked) => {
                                void onTogglePlugin(
                                  agent,
                                  plugin.name,
                                  checked,
                                );
                              }}
                              disabled={restartingAgent}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </TabsPanel>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
