'use client';

import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function RemindersEditor({
  value,
  onChange,
  disabled,
  idPrefix = 'reminders',
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const [draft, setDraft] = useState('');
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState('');

  const addInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editIndex !== null) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editIndex]);

  const commitAdd = () => {
    const trimmed = draft.trim();
    if (!trimmed || value.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...value, trimmed]);
    setDraft('');
  };

  const commitEdit = () => {
    if (editIndex === null) return;
    const trimmed = editText.trim();
    if (!trimmed) {
      cancelEdit();
      return;
    }
    if (value[editIndex] === trimmed) {
      cancelEdit();
      return;
    }
    if (value.includes(trimmed)) {
      cancelEdit();
      return;
    }
    const next = value.slice();
    next[editIndex] = trimmed;
    onChange(next);
    cancelEdit();
  };

  const cancelEdit = () => {
    setEditIndex(null);
    setEditText('');
  };

  const startEdit = (index: number) => {
    setEditIndex(index);
    setEditText(value[index] ?? '');
  };

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
    if (editIndex === index) cancelEdit();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          ref={addInputRef}
          id={`${idPrefix}-add`}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitAdd();
            }
          }}
          placeholder="Add a reminder"
          className="border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={commitAdd}
          className="shrink-0"
        >
          Add
        </Button>
      </div>

      {value.length === 0 ? (
        <div className="py-4 text-center text-sm text-zinc-500">
          No reminders yet.
        </div>
      ) : (
        <div className="max-h-[40vh] space-y-1 overflow-y-auto pr-1">
          {value.map((text, index) => {
            if (editIndex === index) {
              return (
                <div
                  key={`${text}-${index}`}
                  className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2"
                >
                  <Input
                    ref={editInputRef}
                    value={editText}
                    disabled={disabled}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    className="border-zinc-800 bg-zinc-950 text-zinc-100"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={commitEdit}
                    className="shrink-0"
                  >
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={cancelEdit}
                    className="shrink-0 text-zinc-400 hover:text-zinc-100"
                  >
                    Cancel
                  </Button>
                </div>
              );
            }
            return (
              <div
                key={`${text}-${index}`}
                className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm text-zinc-100">
                  {text}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    className="text-zinc-400 hover:text-zinc-100"
                    onClick={() => startEdit(index)}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled}
                    className="text-zinc-400 hover:text-red-400"
                    onClick={() => remove(index)}
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
  );
}
