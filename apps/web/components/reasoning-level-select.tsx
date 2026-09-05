'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectIcon,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
      <Select
        value={value || null}
        onValueChange={(v) => onChange((v as ReasoningLevel | null) ?? null)}
        disabled={disabled}
        items={LEVELS}
      >
        <SelectTrigger>
          <SelectValue placeholder="Default" />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent>
          {LEVELS.map((level) => (
            <SelectItem key={level.value} value={level.value}>
              {level.label}
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
