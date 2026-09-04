'use client';

import { Drawer as DrawerPrimitive } from 'vaul';
import type { ComponentPropsWithoutRef, ElementRef } from 'react';
import { forwardRef } from 'react';

const Drawer = ({
  ...props
}: ComponentPropsWithoutRef<typeof DrawerPrimitive.Root>) => (
  <DrawerPrimitive.Root data-slot="drawer" {...props} />
);

const DrawerTrigger = ({
  ...props
}: ComponentPropsWithoutRef<typeof DrawerPrimitive.Trigger>) => (
  <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
);

const DrawerPortal = ({
  ...props
}: ComponentPropsWithoutRef<typeof DrawerPrimitive.Portal>) => (
  <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
);

const DrawerClose = ({
  ...props
}: ComponentPropsWithoutRef<typeof DrawerPrimitive.Close>) => (
  <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
);

const DrawerOverlay = forwardRef<
  ElementRef<typeof DrawerPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Overlay>
>(({ ...props }, ref) => (
  <DrawerPrimitive.Overlay
    ref={ref}
    data-slot="drawer-overlay"
    className="fixed inset-0 z-50 bg-black/60"
    {...props}
  />
));
DrawerOverlay.displayName = 'DrawerOverlay';

const DrawerContent = forwardRef<
  ElementRef<typeof DrawerPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DrawerPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DrawerPortal data-slot="drawer-portal">
    <DrawerOverlay />
    <DrawerPrimitive.Content
      ref={ref}
      data-slot="drawer-content"
      className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-900 text-zinc-100 shadow-xl ${className ?? ''}`}
      {...props}
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        {children}
      </div>
    </DrawerPrimitive.Content>
  </DrawerPortal>
));
DrawerContent.displayName = 'DrawerContent';

const DrawerHeader = ({
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>) => (
  <div
    data-slot="drawer-header"
    className={`flex items-center justify-between border-b border-zinc-800 px-4 py-3 ${className ?? ''}`}
    {...props}
  />
);

const DrawerFooter = ({
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>) => (
  <div
    data-slot="drawer-footer"
    className={`mt-auto flex items-center justify-between border-t border-zinc-800 px-4 py-3 ${className ?? ''}`}
    {...props}
  />
);

const DrawerTitle = ({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DrawerPrimitive.Title>) => (
  <DrawerPrimitive.Title
    data-slot="drawer-title"
    className={`text-sm font-semibold text-zinc-100 ${className ?? ''}`}
    {...props}
  />
);

const DrawerDescription = ({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DrawerPrimitive.Description>) => (
  <DrawerPrimitive.Description
    data-slot="drawer-description"
    className={`text-xs text-zinc-400 ${className ?? ''}`}
    {...props}
  />
);

export {
  Drawer,
  DrawerTrigger,
  DrawerPortal,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
