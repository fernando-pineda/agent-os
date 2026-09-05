'use client';

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

function Select<T>({ ...props }: SelectPrimitive.Root.Props<T>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectTrigger({ className, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 ring-offset-zinc-950 focus:outline-none focus:ring-1 focus:ring-zinc-600 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
        className,
      )}
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn(
        'truncate text-sm data-[placeholder]:text-zinc-600',
        className,
      )}
      {...props}
    />
  );
}

function SelectContent({ className, ...props }: SelectPrimitive.Popup.Props) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner sideOffset={4} className="z-[9999]">
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'min-w-[10rem] overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 p-1 text-zinc-100 shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        />
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 text-xs outline-none select-none data-highlighted:bg-zinc-800 data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function SelectItemIndicator() {
  return (
    <span className="absolute right-2 flex items-center">
      <CheckIcon className="size-3.5 text-emerald-400" />
    </span>
  );
}

function SelectIcon({ className, ...props }: SelectPrimitive.Icon.Props) {
  return (
    <SelectPrimitive.Icon
      data-slot="select-icon"
      className={cn('size-4 shrink-0 text-zinc-500', className)}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.Icon>
  );
}

export {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectIcon,
  SelectTrigger,
  SelectValue,
};
