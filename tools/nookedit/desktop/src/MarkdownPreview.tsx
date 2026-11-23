import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// react-markdown escapes raw HTML by default. Links are inert because the app
// has no external-navigation handler yet; navigating the webview away from the
// app would strand the user.
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <article className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, children, ...props }) => (
            <a {...props} onClick={(event) => event.preventDefault()}>
              {children}
            </a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </article>
  );
}
