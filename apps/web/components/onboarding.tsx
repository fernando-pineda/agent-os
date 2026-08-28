'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getModels, postOnboarding } from '@/lib/api';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [models, setModels] = useState<
    { id: string; supportsTools: boolean }[]
  >([]);
  const [modelError, setModelError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verifyKey() {
    if (!apiKey.trim()) return;
    setLoading(true);
    setModelError(false);
    try {
      const list = await getModels();
      setModels(list);
      if (list.length > 0 && !defaultModel) {
        setDefaultModel(list[0].id);
      }
    } catch {
      setModelError(true);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    if (!apiKey.trim() || !defaultModel.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await postOnboarding({
        provider: 'fireworks',
        apiKey: apiKey.trim(),
        defaultModel: defaultModel.trim(),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Onboarding failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-medium tracking-tight text-zinc-100">
          agent-os
        </h1>
        <p className="mb-6 text-sm text-zinc-400">
          Enter your Fireworks API key to configure the supervisor.
        </p>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Provider
            </label>
            <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm font-mono text-zinc-300">
              fireworks
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              API key
            </label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="fw-..."
              className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
            />
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={verifyKey}
              disabled={!apiKey.trim() || loading}
              className="border-zinc-700 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
            >
              {loading && models.length === 0 ? 'Loading...' : 'Check key'}
            </Button>
          </div>

          {modelError && (
            <p className="text-xs text-zinc-500">
              Could not load models. You can still enter a model ID manually.
            </p>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-400">
              Default model
            </label>
            {models.length > 0 ? (
              <select
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-zinc-600"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.supportsTools ? ' (tools)' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                placeholder="accounts/fireworks/models/llama-v3-8b-instruct"
                className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
              />
            )}
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <Button
            onClick={submit}
            disabled={!apiKey.trim() || !defaultModel.trim() || loading}
            className="w-full"
          >
            {loading ? 'Saving...' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
}
