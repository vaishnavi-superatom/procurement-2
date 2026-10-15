import React, { useEffect, useState, useMemo } from 'react';
import { marked } from 'marked';
import type { ComponentMetadata } from '../../types';

interface DynamicMarkdownBlockProps {
  content?: string;
  /** 'compact' keeps side padding but trims top/bottom, for blocks stacked in one answer. */
  padding?: 'default' | 'compact';
  SA_RUNTIME?: any;
}

const METADATA: ComponentMetadata = {
  id: 'dynamic-markdown-block',
  name: 'DynamicMarkdownBlock',
  displayName: 'Render markdown text content',
  isDisplayComp: false,
  type: 'MarkdownBlock',
  description: 'Renders rich markdown content as styled HTML. Use for narrative text, executive summaries, analysis commentary, section headers, and any textual content in reports and dashboards. Supports full markdown syntax including headings, bold, italic, lists, tables, blockquotes, code blocks, and horizontal rules. Content supports {%key%} interpolation for dynamic text based on active filters.',
  category: 'display',
  keywords: ['markdown', 'text', 'content', 'report', 'narrative', 'summary', 'commentary', 'section', 'paragraph'],
  props: {
    content: 'Markdown string to render. Supports full markdown syntax (headings, lists, tables, code blocks, blockquotes, bold, italic, links, images, horizontal rules). Supports {%key%} interpolation placeholders.',
    padding: "(optional) 'compact' trims vertical padding; default keeps full padding",
  }
};

interface DynamicMarkdownBlockComponent extends React.FC<DynamicMarkdownBlockProps> {
  Metadata: ComponentMetadata;
}

const DEFAULT_CONTENT = `## Overview

Key highlights from the reporting period:

- Revenue grew by **15%** quarter-over-quarter
- Customer satisfaction maintained at *4.5/5* rating
- New product launches contributed **23%** of total sales

> The overall trajectory remains positive with sustained growth across all major segments.

| Metric | Q1 | Q2 | Change |
|--------|-----|-----|--------|
| Revenue | $1.2M | $1.38M | +15% |
| Orders | 3,400 | 3,890 | +14.4% |
| Avg. Order Value | $353 | $355 | +0.6% |`;

const DynamicMarkdownBlock: React.FC<DynamicMarkdownBlockProps> = ({
  content = DEFAULT_CONTENT,
  padding = 'default',
  SA_RUNTIME = {}
}) => {
  const [filterLabels, setFilterLabels] = useState<Record<string, string>>(() => {
    const eventName = SA_RUNTIME?.uiBlockId ? `${SA_RUNTIME.uiBlockId}_FILTER` : 'GLOBAL_FILTER';
    return (window as any).__FILTER_STATE__?.[eventName]?.labels || {};
  });

  const interpolate = (template: string, labels: Record<string, string>): string => {
    if (Object.keys(labels).length === 0) {
      return template.replace(/\{%(\w+)%\}\s*[-–—]\s*/g, '').replace(/\{%(\w+)%\}/g, '').trim();
    }
    return template.replace(/\{%(\w+)%\}/g, (_, key) =>
      labels[key] !== undefined && labels[key] !== '' ? labels[key] : ''
    );
  };

  const displayContent = interpolate(content, filterLabels);

  const uiBlockId = SA_RUNTIME?.uiBlockId;

  // Listen for filter events for interpolation updates
  useEffect(() => {
    const eventName = uiBlockId
      ? `${uiBlockId}_FILTER`
      : 'GLOBAL_FILTER';

    const handleFilterChange = (event: CustomEvent) => {
      const { filterKey, filterLabel } = event.detail || {};

      if (filterKey && filterLabel !== undefined) {
        setFilterLabels(prev => ({ ...prev, [`${filterKey}Label`]: filterLabel }));
      }
    };

    window.addEventListener(eventName, handleFilterChange as EventListener);

    return () => {
      window.removeEventListener(eventName, handleFilterChange as EventListener);
    };
  }, [uiBlockId]);

  // Configure marked — open all links in a new tab
  useMemo(() => {
    const renderer = new marked.Renderer();
    /* Regular function, not an arrow function: `this.parser` below only
     * resolves because marked calls this as `renderer.link(token)`, a plain
     * method call — an arrow function would keep the outer (unrelated) `this`
     * instead and throw.
     *
     * Also fixes a pre-existing bug: marked v17's actual link-token shape is
     * `{ href, title, tokens }` (an array of inline nodes, rendered via
     * `this.parser.parseInline`), not `{ text }` — the previous code
     * destructured a field that doesn't exist on this token, so `text` was
     * always undefined and every link in chat rendered with no visible text. */
    renderer.link = function ({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      if (href?.startsWith('data:')) {
        /* A generated file's own bytes, base64-encoded directly into the
         * href — there's no server to fetch it from, so `download` is what
         * makes the browser save it instead of trying to navigate to or
         * render the data: URI inline. `title` carries the filename to save
         * as (assembleAnswer sets it server-side); a bare `download` with no
         * value falls back to a browser-chosen name. */
        const filename = (title || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return `<a href="${href}" download="${filename}">${text}</a>`;
      }
      return `<a href="${href}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
    };
    marked.setOptions({ gfm: true, breaks: true });
    marked.use({ renderer });
  }, []);

  // Convert markdown to HTML
  const htmlContent = useMemo(() => {
    return marked.parse(displayContent) as string;
  }, [displayContent]);

  const markdownStyles = `
    [&>*:last-child]:mb-0
    [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-base-content [&_h1]:first:mt-0
    [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base-content [&_h2]:first:mt-0
    [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-base-content [&_h3]:first:mt-0
    [&_h4]:text-base [&_h4]:font-semibold [&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-base-content
    [&_h5]:text-sm [&_h5]:font-medium [&_h5]:mb-1 [&_h5]:mt-2 [&_h5]:text-base-content
    [&_h6]:text-sm [&_h6]:font-medium [&_h6]:mb-1 [&_h6]:mt-2 [&_h6]:text-base-content/80

    [&_p]:mb-3 [&_p]:leading-relaxed [&_p]:text-base-content/85 [&_p]:text-sm [&_p]:last:mb-0

    [&_strong]:font-bold [&_strong]:text-base-content
    [&_em]:italic

    [&_a]:text-primary [&_a]:underline [&_a]:hover:opacity-80

    [&_ul]:list-disc [&_ul]:ml-5 [&_ul]:mb-3 [&_ul]:space-y-1
    [&_ol]:list-decimal [&_ol]:ml-5 [&_ol]:mb-3 [&_ol]:space-y-1
    [&_li]:text-sm [&_li]:text-base-content/85 [&_li]:leading-relaxed

    [&_blockquote]:border-l-4 [&_blockquote]:border-primary/30 [&_blockquote]:pl-4 [&_blockquote]:py-2 [&_blockquote]:my-3 [&_blockquote]:bg-base-200/50 [&_blockquote]:rounded-r-lg [&_blockquote]:italic [&_blockquote]:text-base-content/70

    [&_code]:bg-base-200 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono [&_code]:text-base-content/80
    [&_pre]:bg-base-200 [&_pre]:p-4 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:mb-3 [&_pre]:text-sm
    [&_pre_code]:bg-transparent [&_pre_code]:p-0

    [&_hr]:border-base-300 [&_hr]:my-4

    [&_img]:rounded-lg [&_img]:max-w-full [&_img]:my-3

    [&_table]:w-full [&_table]:mb-3 [&_table]:border-collapse [&_table]:text-sm
    [&_thead]:bg-base-200
    [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:border [&_th]:border-base-300 [&_th]:text-base-content
    [&_td]:px-3 [&_td]:py-2 [&_td]:border [&_td]:border-base-300 [&_td]:text-base-content/85
    [&_tr:nth-child(even)]:bg-base-200/30
  `.trim().replace(/\s+/g, ' ');

  return (
    <div
      // Padding belongs here, not on the caller: this block is read as prose —
      // a chat answer, a report section — and without it the text runs into
      // whatever card it sits in.
      className={`${padding === 'compact' ? 'px-4 md:px-5 py-1' : 'p-4 md:p-5'} ${markdownStyles}`}
      dangerouslySetInnerHTML={{ __html: htmlContent }}
    />
  );
};

// Attach metadata to component
(DynamicMarkdownBlock as DynamicMarkdownBlockComponent).Metadata = METADATA;

export default DynamicMarkdownBlock;
