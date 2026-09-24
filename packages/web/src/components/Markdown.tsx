import { isValidElement, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import { documentFormatOf } from "../lib/markdownExport";
import { DocumentCard } from "./DocumentCard";

/**
 * Esquema de saneado: parte del esquema por defecto pero SIN imágenes.
 * react-markdown no interpreta HTML crudo (sin rehype-raw), así que las etiquetas
 * escritas en el texto se muestran escapadas.
 */
const schema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img" && t !== "picture" && t !== "source"),
  attributes: Object.fromEntries(
    Object.entries(defaultSchema.attributes ?? {}).filter(([tag]) => tag !== "img"),
  ),
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto", "tel"] },
};

function isOpenableUrl(href: string): boolean {
  try {
    const u = new URL(href, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function ExternalLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const target = href ?? "";
  if (!target || !isOpenableUrl(target)) {
    return <span className="md-link-text">{children}</span>;
  }
  const open = () => {
    const ok = window.confirm(`You are about to open an external link in a new tab:\n\n${target}\n\nContinue?`);
    if (!ok) return;
    const w = window.open(target, "_blank", "noopener,noreferrer");
    if (w) w.opener = null;
  };
  return (
    <span className="md-link">
      <span className="md-link-text">{children}</span>{" "}
      <button type="button" className="btn btn-link-ext" onClick={open} title={target}>
        Open external link
      </button>
    </span>
  );
}

/** The text inside a rendered code element (react-markdown hands it over as a string, or pieces of one). */
function codeText(children: ReactNode): string {
  if (Array.isArray(children)) return children.map(codeText).join("");
  return typeof children === "string" ? children : "";
}

interface Props {
  text: string;
  /** The message has finished streaming: a document card in it may be downloaded. */
  documentReady?: boolean;
  /** Name for a document without a title of its own (the conversation's title). */
  fallbackTitle?: string;
  /** Inside a document card's preview: fences are shown as text, never as another card. */
  nested?: boolean;
}

export function Markdown({ text, documentReady = true, fallbackTitle = "", nested = false }: Props) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
      // Por si algo se colara: nunca renderizamos imágenes.
      img: () => null,
      // A fenced block whose language is `document` (or document-pdf, -txt, -csv) is a file the model
      // hands over: it is shown as a document card with its downloads instead of as code.
      pre: ({ node: _node, children, ...rest }) => {
        const child = Array.isArray(children) ? children[0] : children;
        if (!nested && isValidElement<{ className?: string; children?: ReactNode }>(child)) {
          const format = documentFormatOf(child.props.className);
          if (format) return <DocumentCard markdown={codeText(child.props.children)} format={format} ready={documentReady} fallbackTitle={fallbackTitle} />;
        }
        return <pre {...rest}>{children}</pre>;
      },
    }),
    [documentReady, fallbackTitle, nested],
  );
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, schema]]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
