import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Assistant replies are markdown. Links are rendered as plain text with the URL
 * shown, because clicking through would need a navigation decision the user has
 * not made -- copy the address instead.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <span>
            {children} <span className="dim small">({href})</span>
          </span>
        ),
        img: ({ alt }) => <span className="dim small">[image: {alt || 'untitled'}]</span>
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
