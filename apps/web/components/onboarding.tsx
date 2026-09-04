'use client';

import { useEffect, useState } from 'react';
import { ModelPickerModal } from '@/components/model-picker-modal';
import { Button } from '@/components/ui/button';
import { getModels, postOnboarding } from '@/lib/api';
import type { ModelItem } from '@/lib/types';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [defaultModel, setDefaultModel] = useState('');
  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelError, setModelError] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getModels()
      .then((list) => {
        if (!active) return;
        setModels(list);
        setDefaultModel((current) => current || list[0]?.id || '');
      })
      .catch((err) => {
        if (!active) return;
        setModelError(true);
        setError(err instanceof Error ? err.message : 'Failed to load models');
      })
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const model = defaultModel.trim();
      await postOnboarding(model ? { defaultModel: model } : {});
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Onboarding failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-900 p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-medium tracking-tight text-zinc-100">
          agent-os
        </h1>
        <p className="mb-6 text-sm text-zinc-400">
          Choose a default model for the supervisor.
        </p>

        <div className="space-y-4">
          {modelError && (
            <p className="text-xs text-zinc-500">
              Could not load models. You can still enter a model ID manually.
            </p>
          )}

          <ModelPickerModal
            models={models}
            value={defaultModel}
            onChange={setDefaultModel}
            loading={modelsLoading}
            allowManual={modelError || models.length === 0}
            placeholder="Select a model"
          />

          {error && <p className="text-sm text-red-400">{error}</p>}

          <Button onClick={submit} disabled={saving} className="w-full">
            {saving ? 'Saving...' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
}
