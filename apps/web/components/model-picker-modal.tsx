'use client';

import { CheckIcon, CpuIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ModelItem } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ModelPickerModalProps {
  models: ModelItem[];
  value: string;
  onChange: (modelId: string) => void;
  loading?: boolean;
  allowManual?: boolean;
  placeholder?: string;
  label?: string;
}

export function ModelPickerModal({
  models,
  value,
  onChange,
  loading = false,
  allowManual = false,
  placeholder = 'Select a model',
  label = 'Model',
}: ModelPickerModalProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [manualInput, setManualInput] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return models;
    const q = query.toLowerCase();
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, query]);

  const displayValue = useMemo(() => {
    if (!value) return placeholder;
    const parts = value.split('/');
    return parts[parts.length - 1] ?? value;
  }, [value, placeholder]);

  function handleSelect(id: string) {
    onChange(id);
    setOpen(false);
    setQuery('');
  }

  function handleManualSubmit() {
    if (manualInput.trim()) {
      handleSelect(manualInput.trim());
      setManualInput('');
    }
  }

  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-400">
        {label}
      </label>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button
              variant="outline"
              className="h-9 w-full justify-between border-zinc-800 bg-zinc-950 px-3 text-sm font-normal text-zinc-100 hover:bg-zinc-800"
            />
          }
        >
          <span className="flex items-center gap-2 truncate">
            <CpuIcon className="size-4 text-zinc-500 shrink-0" />
            <span className={cn('truncate', !value && 'text-zinc-600')}>
              {loading ? 'Loading models...' : displayValue}
            </span>
          </span>
        </DialogTrigger>
        <DialogContent className="sm:max-w-2xl border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Select a model</DialogTitle>
          </DialogHeader>

          {/* Search bar */}
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              className="border-zinc-800 bg-zinc-950 pl-9 text-zinc-100 placeholder:text-zinc-600"
            />
          </div>

          {/* Model list */}
          <div className="max-h-72 overflow-y-auto rounded-md border border-zinc-800">
            {filtered.length === 0 && !allowManual && (
              <div className="px-3 py-6 text-center text-xs text-zinc-500">
                No models found.
              </div>
            )}
            <ul className="divide-y divide-zinc-800">
              {filtered.map((m) => {
                const selected = m.id === value;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(m.id)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-zinc-800',
                        selected && 'bg-zinc-800',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-zinc-200 break-all">
                          {m.id}
                        </div>
                        {m.supportsTools && (
                          <span className="mt-0.5 inline-block rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
                            tools
                          </span>
                        )}
                      </div>
                      {selected && (
                        <CheckIcon className="size-4 shrink-0 text-emerald-400" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Manual entry */}
          {allowManual && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">
                Or enter a model ID manually:
              </p>
              <div className="flex gap-2">
                <Input
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleManualSubmit();
                    }
                  }}
                  placeholder="accounts/fireworks/models/..."
                  className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
                />
                <Button
                  variant="outline"
                  onClick={handleManualSubmit}
                  disabled={!manualInput.trim()}
                  className="border-zinc-700 text-zinc-200 hover:bg-zinc-800"
                >
                  Use
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
