import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

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
    const ok = window.confirm(`Vas a abrir un enlace externo en una pestaña nueva:\n\n${target}\n\n¿Continuar?`);
    if (!ok) return;
    const w = window.open(target, "_blank", "noopener,noreferrer");
    if (w) w.opener = null;
  };
  return (
    <span className="md-link">
      <span className="md-link-text">{children}</span>{" "}
      <button type="button" className="btn btn-link-ext" onClick={open} title={target}>
        Abrir enlace externo
      </button>
    </span>
  );
}

const components: Components = {
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  // Por si algo se colara: nunca renderizamos imágenes.
  img: () => null,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, schema]]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
