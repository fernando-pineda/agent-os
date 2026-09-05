'use client';

import { type JSX, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

type WidgetFrameProps = {
  html: string;
  title?: string;
};

type WidgetResizeMessage = {
  type: 'widget-resize';
  height: number;
};

const wrapWidgetHtml = (
  html: string,
): string => `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;padding:12px}</style>
</head><body>${html}
<script>
function sendHeight(){parent.postMessage({type:'widget-resize',height:document.body.scrollHeight},'*')}
window.addEventListener('load',sendHeight);
new ResizeObserver(sendHeight).observe(document.body);
</script>
</body></html>`;

export function WidgetFrame({ html, title }: WidgetFrameProps): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<WidgetResizeMessage>): void => {
      if (
        event.origin !== 'null' ||
        event.source !== iframeRef.current?.contentWindow ||
        event.data == null ||
        typeof event.data !== 'object' ||
        event.data.type !== 'widget-resize' ||
        !Number.isFinite(event.data.height)
      ) {
        return;
      }

      setHeight(Math.max(1, Math.ceil(event.data.height)));
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <div
      data-slot="widget-frame"
      className={cn(
        'aui-widget-frame border-border/50 bg-muted/30 overflow-hidden rounded-xl border',
      )}
    >
      {title ? (
        <div
          data-slot="widget-frame-header"
          className="aui-code-header-root border-border/50 bg-muted/50 flex items-center border-b px-3.5 py-1.5 text-xs"
        >
          <span className="aui-code-header-language text-muted-foreground font-medium">
            {title}
          </span>
        </div>
      ) : null}
      <iframe
        data-slot="widget-frame-iframe"
        ref={iframeRef}
        title={title ?? 'HTML widget'}
        sandbox="allow-scripts"
        srcDoc={wrapWidgetHtml(html)}
        className="aui-widget-frame-iframe block w-full border-0 bg-background"
        style={{ height: `${height}px` }}
      />
    </div>
  );
}
