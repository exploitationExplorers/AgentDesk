import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@agentdesk/ui";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("ad-prose", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
