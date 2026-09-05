'use client';

import { cn } from '@/lib/utils';
import type { ReasoningLevel } from '@/lib/types';

const LEVELS: { value: ReasoningLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
  { value: 'max', label: 'Max' },
];

interface ReasoningLevelSelectProps {
  value: string;
  onChange: (level: ReasoningLevel | null) => void;
  disabled?: boolean;
}

export function ReasoningLevelSelect({
  value,
  onChange,
  disabled = false,
}: ReasoningLevelSelectProps) {
  return (
    <div className="shrink-0">
      <label className="mb-1.5 block text-xs font-medium text-zinc-400">
        Reasoning
      </label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v ? (v as ReasoningLevel) : null);
        }}
        className={cn(
          'h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100',
          'focus:outline-none focus:ring-1 focus:ring-zinc-600',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <option value="">Default</option>
        {LEVELS.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}
