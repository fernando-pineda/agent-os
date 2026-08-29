'use client';

import { PlayIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  createAutomation,
  deleteAutomation,
  getAutomations,
  runAutomation,
  updateAutomation,
} from '@/lib/api';
import type { Automation, CreateAutomationPayload } from '@/lib/types';

const textareaClass =
  'w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-700';

const inputClass = 'border-zinc-800 bg-zinc-950 text-zinc-100';

export function AutomationsPanel({ agentId }: { agentId: string }) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [cron, setCron] = useState('');
  const [prompt, setPrompt] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  const [actionId, setActionId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await getAutomations(agentId);
      setAutomations(list);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load automations',
      );
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetForm = useCallback(() => {
    setName('');
    setCron('');
    setPrompt('');
    setEnabled(true);
    setFormError('');
  }, []);

  const onSubmit = useCallback(async () => {
    if (!name.trim()) {
      setFormError('Name is required');
      return;
    }
    if (!cron.trim()) {
      setFormError('Cron expression is required');
      return;
    }
    if (!prompt.trim()) {
      setFormError('Prompt is required');
      return;
    }
    setCreating(true);
    setFormError('');
    try {
      const payload: CreateAutomationPayload = {
        name: name.trim(),
        cron: cron.trim(),
        prompt: prompt.trim(),
        enabled,
      };
      await createAutomation(agentId, payload);
      resetForm();
      setShowForm(false);
      void refresh();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Failed to create automation',
      );
    } finally {
      setCreating(false);
    }
  }, [name, cron, prompt, enabled, agentId, resetForm, refresh]);

  const onToggleEnabled = useCallback(
    async (auto: Automation) => {
      setActionId(auto.id);
      try {
        await updateAutomation(agentId, auto.id, {
          enabled: !auto.enabled,
        });
        void refresh();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to toggle automation',
        );
      } finally {
        setActionId(null);
      }
    },
    [agentId, refresh],
  );

  const onRunNow = useCallback(
    async (auto: Automation) => {
      setActionId(auto.id);
      try {
        await runAutomation(agentId, auto.id);
        void refresh();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to run automation',
        );
      } finally {
        setActionId(null);
      }
    },
    [agentId, refresh],
  );

  const onDelete = useCallback(
    async (auto: Automation) => {
      setActionId(auto.id);
      try {
        await deleteAutomation(agentId, auto.id);
        void refresh();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to delete automation',
        );
      } finally {
        setActionId(null);
      }
    },
    [agentId, refresh],
  );

  return (
    <div className="space-y-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-400">Automations</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-100"
            onClick={() => void refresh()}
            disabled={loading}
          >
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs text-zinc-300"
            onClick={() => setShowForm(true)}
          >
            + New
          </Button>
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        Scheduled wake-ups. On each tick the agent is woken with the prompt in
        its inbox and acts using its connected plugins.
      </p>

      {error && <div className="text-xs text-destructive">{error}</div>}

      <Dialog
        open={showForm}
        onOpenChange={(open) => {
          if (!open) resetForm();
          setShowForm(open);
        }}
      >
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New automation</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 overflow-y-auto py-2 pr-1">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="slack-mentions"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Cron expression
              </label>
              <Input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="*/5 * * * *"
                className={inputClass}
              />
              <p className="mt-1 text-xs text-zinc-500">
                Standard 5-field cron. Checked by the agent process.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                className={textareaClass}
                placeholder="Check Slack for new mentions and summarize them."
              />
              <p className="mt-1 text-xs text-zinc-500">
                Delivered to the agent's inbox on each run.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="size-4 rounded border-zinc-700 bg-zinc-950"
              />
              Enabled
            </label>
            {formError && (
              <div className="text-xs text-destructive">{formError}</div>
            )}
            <Button
              onClick={onSubmit}
              disabled={creating}
              className="w-full"
              size="sm"
            >
              {creating ? 'Creating...' : 'Create automation'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {loading && automations.length === 0 ? (
        <div className="py-4 text-center text-xs text-zinc-500">Loading...</div>
      ) : automations.length === 0 ? (
        <div className="py-4 text-center text-sm text-zinc-500">
          No automations yet.
        </div>
      ) : (
        <div className="max-h-[55vh] space-y-1 overflow-y-auto pr-1">
          {automations.map((auto) => (
            <div
              key={auto.id}
              className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm text-zinc-100">
                    <span className="truncate">{auto.name}</span>
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        auto.enabled ? 'bg-emerald-400' : 'bg-zinc-600'
                      }`}
                      title={auto.enabled ? 'enabled' : 'disabled'}
                    />
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-zinc-500">
                    {auto.cron}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-zinc-400 hover:text-zinc-100"
                    onClick={() => void onRunNow(auto)}
                    disabled={actionId === auto.id}
                    title="Run now"
                  >
                    <PlayIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-zinc-400 hover:text-red-400"
                    onClick={() => void onDelete(auto)}
                    disabled={actionId === auto.id}
                    title="Delete"
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
              {auto.prompt && (
                <div className="mt-1 truncate text-xs text-zinc-400">
                  {auto.prompt}
                </div>
              )}
              <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
                <label className="flex items-center gap-1.5 text-zinc-400">
                  <input
                    type="checkbox"
                    checked={auto.enabled}
                    onChange={() => void onToggleEnabled(auto)}
                    disabled={actionId === auto.id}
                    className="size-3.5 rounded border-zinc-700 bg-zinc-950"
                  />
                  Enabled
                </label>
              </div>
              {auto.lastRunAt && (
                <div className="mt-1 text-xs text-zinc-500">
                  Last run: {auto.lastRunAt}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
