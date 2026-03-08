import { useState, useCallback, type ReactNode } from "react";
import DOMPurify from "dompurify";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";

// Sanitize Matrix HTML — allow safe tags only
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p", "br", "hr",
      "strong", "b", "em", "i", "u", "s", "del", "strike",
      "code", "pre",
      "a", "img",
      "ul", "ol", "li",
      "blockquote",
      "table", "thead", "tbody", "tr", "th", "td",
      "span", "div",
      "sup", "sub",
      "mx-reply",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "data-mx-color", "data-mx-bg-color", "target", "rel"],
  });
}

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) return extractText((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = extractText(children);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [children]);

  return (
    <pre className="md-code-block" style={{
      position: 'relative',
      background: 'var(--color-surface-container-lowest)',
      border: '1px solid var(--color-outline-variant)',
      borderRadius: 16,
      padding: 16,
      margin: '8px 0',
      overflowX: 'auto' as const,
      maxWidth: '100%',
      fontSize: 12,
      fontFamily: 'var(--font-family-mono)',
    }}>
      <button
        onClick={handleCopy}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          padding: '4px 8px',
          borderRadius: 8,
          border: 'none',
          cursor: 'pointer',
          fontSize: 11,
          fontFamily: 'inherit',
          background: copied ? 'var(--color-primary-container)' : 'var(--color-surface-container-high)',
          color: copied ? 'var(--color-primary)' : 'var(--color-on-surface-variant)',
          opacity: copied ? 1 : 0.7,
          transition: 'all 150ms',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { if (!copied) e.currentTarget.style.opacity = '0.7'; }}
      >
        {copied ? "✓" : "⎘"}
      </button>
      {children}
    </pre>
  );
}

const components: Components = {
  p: ({ children }) => <p style={{ margin: '2px 0' }}>{children}</p>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = Boolean(className);
    if (isBlock) {
      return <code className={className} style={{ fontFamily: 'var(--font-family-mono)' }}>{children}</code>;
    }
    return (
      <code style={{
        background: 'var(--color-surface-container-highest)',
        borderRadius: 6,
        padding: '2px 6px',
        fontSize: 12,
        fontFamily: 'var(--font-family-mono)',
      }}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  ul: ({ children }) => <ul style={{ paddingLeft: 20, margin: '4px 0' }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ paddingLeft: 20, margin: '4px 0' }}>{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote style={{
      borderLeft: '3px solid var(--color-primary)',
      paddingLeft: 12,
      margin: '6px 0',
      color: 'var(--color-on-surface-variant)',
      fontStyle: 'italic',
    }}>
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto' as const, margin: '8px 0', borderRadius: 12, border: '1px solid var(--color-outline-variant)' }}>
      <table style={{ borderCollapse: 'collapse' as const, fontSize: 12, width: '100%' }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ borderBottom: '1px solid var(--color-outline-variant)', padding: '8px 12px', background: 'var(--color-surface-container)', textAlign: 'left' as const, fontWeight: 600, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: 'var(--color-on-surface-variant)' }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{ borderBottom: '1px solid var(--color-outline-variant)', padding: '8px 12px' }}>{children}</td>
  ),
  strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del style={{ color: 'var(--color-outline)' }}>{children}</del>,
  img: ({ src, alt }) => (
    <img src={src} alt={alt || ""} style={{ maxWidth: 400, borderRadius: 16, margin: '4px 0' }} loading="lazy" />
  ),
};

interface MarkdownRendererProps {
  content: string;
  /** Pre-formatted HTML from Matrix (org.matrix.custom.html) */
  formattedBody?: string;
  /** Message type (m.text, m.notice, m.emote) */
  msgtype?: string;
}

export function MarkdownRenderer({ content, formattedBody, msgtype }: MarkdownRendererProps) {
  // If Matrix HTML is available, sanitize and render directly
  if (formattedBody) {
    const clean = sanitizeHtml(formattedBody);
    return (
      <div
        className="matrix-html"
        dangerouslySetInnerHTML={{ __html: clean }}
      />
    );
  }

  // m.notice messages (bot output) — preserve whitespace formatting
  if (msgtype === "m.notice") {
    return (
      <pre style={{
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'var(--font-family-mono)',
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        {content}
      </pre>
    );
  }

  // Regular messages — render as Markdown
  return (
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
      {content}
    </Markdown>
  );
}
