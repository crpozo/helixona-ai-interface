import { Fragment, useEffect } from "react";
import { brand } from "../brand";
import { docxUrl, documents, findDocument, type Cell, type DocNode, type HipaaDocument, type Run } from "../docs";
import { documentSlug, navigate, usePath, type Path } from "../lib/router";
import { Logo } from "./Logo";

interface Props {
  /** Label of the link that leaves the documentation. */
  backLabel: string;
  /** Where that link goes: the sign-in page for visitors, the assistant for signed-in staff. */
  backTo: "/login" | "/";
}

const SIGNATURE_WIDTHS = [3400, 3600, 2360];

function go(to: Path) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
  };
}

function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r, k) =>
        typeof r === "string" ? <Fragment key={k}>{r}</Fragment> : "b" in r ? <strong key={k}>{r.b}</strong> : <em key={k}>{r.i}</em>,
      )}
    </>
  );
}

function CellLines({ value }: { value: Cell }) {
  const lines = Array.isArray(value) ? value : [value];
  return (
    <>
      {lines.map((l, k) => (
        <div key={k}>{l}</div>
      ))}
    </>
  );
}

function ColGroup({ widths }: { widths: number[] }) {
  const total = widths.reduce((a, c) => a + c, 0);
  return (
    <colgroup>
      {widths.map((w, k) => (
        <col key={k} style={{ width: `${((w / total) * 100).toFixed(1)}%` }} />
      ))}
    </colgroup>
  );
}

function DataTable({ headers, rows, widths, className }: { headers: string[]; rows: Cell[][]; widths: number[]; className?: string }) {
  return (
    <div className="doc-table-wrap">
      <table className={className}>
        <ColGroup widths={widths} />
        <thead>
          <tr>
            {headers.map((h, k) => (
              <th key={k} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((c, k) => (
                <td key={k} className={k === 0 && row.length > 2 ? "lead" : undefined}>
                  <CellLines value={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KvTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="doc-table-wrap">
      <table className="doc-kv">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Node({ node, id }: { node: DocNode; id: string }) {
  switch (node.type) {
    case "title":
      return (
        <header className="doc-cover">
          <p className="eyebrow">{brand.name}</p>
          <h1>{node.title}</h1>
          <p className="doc-subtitle">{node.subtitle}</p>
          <KvTable rows={node.meta} />
        </header>
      );
    case "h": {
      const Tag = node.level === 1 ? "h2" : node.level === 2 ? "h3" : "h4";
      return <Tag id={id}>{node.text}</Tag>;
    }
    case "p": {
      const cls = [node.italics ? "italic" : "", node.bold ? "bold" : "", node.size !== undefined && node.size < 22 ? "small" : ""].filter(Boolean).join(" ");
      return (
        <p className={cls || undefined}>
          <Runs runs={node.runs} />
        </p>
      );
    }
    case "note":
      return <aside className="doc-note">{node.text}</aside>;
    case "list": {
      const Tag = node.ordered ? "ol" : "ul";
      return (
        <Tag>
          {node.items.map((item, k) => (
            <li key={k}>
              <Runs runs={item} />
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return <DataTable headers={node.headers} rows={node.rows} widths={node.widths} />;
    case "kv":
      return <KvTable rows={node.rows} />;
    case "signatures":
      return <DataTable className="doc-signatures" headers={["Name and role", "Signature", "Date"]} rows={node.roles.map((r) => [r, "", ""])} widths={SIGNATURE_WIDTHS} />;
    case "spacer":
      return null;
    case "pageBreak":
      return <hr className="doc-break" />;
  }
}

function jumpTo(id: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
}

function DocumentView({ doc }: { doc: HipaaDocument }) {
  const toc = doc.children.flatMap((n, k) => (n.type === "h" && n.level === 1 ? [{ id: `s${k}`, text: n.text }] : []));
  return (
    <div className="docs-layout">
      <nav className="docs-toc" aria-label="Contents">
        <h2>Contents</h2>
        <ol>
          {toc.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} onClick={jumpTo(t.id)}>
                {t.text}
              </a>
            </li>
          ))}
        </ol>
        <div className="docs-toc-actions">
          <a className="btn btn-primary block" href={docxUrl(doc)} download>
            Download Word file
          </a>
          <button type="button" className="btn block" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </nav>
      <article className="doc" aria-label={doc.title}>
        {doc.children.map((n, k) => (
          <Node key={k} node={n} id={`s${k}`} />
        ))}
        <footer className="doc-foot">Confidential. Internal use only.</footer>
      </article>
    </div>
  );
}

function IndexView() {
  return (
    <>
      <p className="eyebrow">HIPAA documentation</p>
      <h1 className="docs-index-title">Compliance documents</h1>
      <p className="docs-intro">
        The three documents the clinic keeps for the {brand.productName}: what the risks are and how they are controlled, the rules staff and
        administrators follow, and the training every user completes before their first sign-in. Read them here, or download the Word files to
        fill in, sign and file.
      </p>
      <div className="docs-cards">
        {documents.map((d) => (
          <section className="docs-card" key={d.slug} aria-labelledby={`card-${d.slug}`}>
            <h2 id={`card-${d.slug}`}>{d.title}</h2>
            <p>{d.summary}</p>
            <div className="docs-card-actions">
              <a className="btn btn-primary" href={`/documentation/${d.slug}`} onClick={go(`/documentation/${d.slug}`)}>
                Read online
              </a>
              <a className="btn" href={docxUrl(d)} download>
                Download Word file
              </a>
            </div>
          </section>
        ))}
      </div>
      <section className="docs-how" aria-labelledby="docs-how">
        <h2 id="docs-how">How the clinic uses them</h2>
        <ol>
          <li>Fill in the bracketed names and dates, and have the Privacy Officer, the Security Officer and the owner sign the risk analysis and the policies.</li>
          <li>Deliver the training to every user before their first sign-in and keep each signed acknowledgment.</li>
          <li>Keep the signed copies with the clinic's compliance records for at least six years, and review them every year or after any major change.</li>
        </ol>
      </section>
    </>
  );
}

/** Public documentation: the HIPAA documents, readable on screen and downloadable as Word files. */
export function DocumentationPage({ backLabel, backTo }: Props) {
  const path = usePath();
  const slug = documentSlug(path);
  const doc = slug ? findDocument(slug) : undefined;

  useEffect(() => {
    if (import.meta.env.MODE !== "test") window.scrollTo(0, 0);
  }, [slug]);
  useEffect(() => {
    document.title = `${doc ? doc.title : "Documentation"} · ${brand.productName}`;
    return () => {
      document.title = brand.productName;
    };
  }, [doc]);

  return (
    <div className="docs">
      <header className="login-bar docs-bar">
        <Logo variant="login" />
        <nav className="login-bar-right" aria-label="Documentation">
          {doc && (
            <a className="login-bar-link" href="/documentation" onClick={go("/documentation")}>
              All documents
            </a>
          )}
          <a className="login-bar-link" href={backTo} onClick={go(backTo)}>
            {backLabel}
          </a>
        </nav>
      </header>
      <main className="docs-main">{doc ? <DocumentView doc={doc} /> : <IndexView />}</main>
    </div>
  );
}
