'use client';

import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import type * as React from 'react';
import { cn } from '@/lib/utils';

function Menu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />;
}

function MenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

function MenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="menu-portal" {...props} />;
}

function MenuContent({ className, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <MenuPortal>
      <MenuPrimitive.Positioner sideOffset={4} className="z-[9999]">
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            'min-w-[10rem] overflow-hidden rounded-md border border-zinc-800 bg-zinc-900 p-1 text-zinc-100 shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPortal>
  );
}

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(
        'relative flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-xs outline-none select-none data-highlighted:bg-zinc-800 data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn('my-1 h-px bg-zinc-800', className)}
      {...props}
    />
  );
}

export { Menu, MenuContent, MenuItem, MenuPortal, MenuSeparator, MenuTrigger };
