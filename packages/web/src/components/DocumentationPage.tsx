import { Fragment, useEffect, type ReactNode } from "react";
import { brand } from "../brand";
import { docxUrl, documents, findDocument, type Cell, type DocNode, type HipaaDocument, type Run } from "../docs";
import { documentSlug, navigate, usePath, type Path } from "../lib/router";
import type { Me } from "../lib/types";
import { Logo } from "./Logo";
import { TrainingCheck, TrainingLog } from "./TrainingSections";

interface Props {
  /** Label of the link that leaves the documentation. */
  backLabel: string;
  /** Where that link goes: the sign-in page for visitors, the assistant for signed-in staff. */
  backTo: "/login" | "/";
  /** The signed-in user, when there is one: enables the online knowledge check. */
  me?: Me | null;
}

/** Replaces a top-level section of a document (keyed by its heading) with interactive content; null hides it. */
type SectionRender = (section: { heading: ReactNode; body: ReactNode }) => ReactNode;

const keepSection: SectionRender = ({ heading, body }) => (
  <>
    {heading}
    {body}
  </>
);
const hideSection: SectionRender = () => null;

/** The workforce training: the check is completed online by signed-in staff; there is nothing to sign. */
function trainingSections(me: Me | null | undefined): Record<string, SectionRender> {
  // The answer key is for the trainer: administrators, and only once their own training is done.
  const isAdmin = !!me?.user.roles.includes("admin") && (!me?.training?.required || !!me.training.complete);
  return {
    "Knowledge check": me
      ? ({ heading }) => (
          <>
            {heading}
            <TrainingCheck me={me} />
          </>
        )
      : ({ heading, body }) => (
          <>
            {heading}
            <aside className="doc-note">Staff complete this check online after signing in: the score is saved to the training log. The paper version below is the alternative.</aside>
            {body}
          </>
        ),
    "Answer key (for the trainer)": isAdmin ? keepSection : hideSection,
    "Training log": isAdmin
      ? ({ heading }) => (
          <>
            {heading}
            <TrainingLog />
          </>
        )
      : hideSection,
  };
}

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
    case "spacer":
      return null;
    case "pageBreak":
      return <hr className="doc-break" />;
  }
}

/** Renders a list of document nodes (used by the training course to show one module at a time). */
export function DocNodes({ nodes, idPrefix }: { nodes: DocNode[]; idPrefix: string }) {
  return (
    <>
      {nodes.map((n, k) => (
        <Node key={k} node={n} id={`${idPrefix}-${k}`} />
      ))}
    </>
  );
}

function jumpTo(id: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
}

/** Renders the document, handing whole sections to their override when one exists. */
function renderSections(doc: HipaaDocument, overrides: Record<string, SectionRender>): { elements: ReactNode[]; hidden: Set<string> } {
  const elements: ReactNode[] = [];
  const hidden = new Set<string>();
  const isTop = (n: DocNode) => n.type === "h" && n.level === 1;
  let i = 0;
  while (i < doc.children.length) {
    const node = doc.children[i]!;
    const id = `s${i}`;
    const override = node.type === "h" && node.level === 1 ? overrides[node.text] : undefined;
    if (!override) {
      elements.push(<Node key={id} node={node} id={id} />);
      i++;
      continue;
    }
    let j = i + 1;
    const body: ReactNode[] = [];
    while (j < doc.children.length && !isTop(doc.children[j]!)) {
      body.push(<Node key={`s${j}`} node={doc.children[j]!} id={`s${j}`} />);
      j++;
    }
    const rendered = override({ heading: <Node node={node} id={id} />, body: <>{body}</> });
    if (rendered === null) hidden.add(id);
    else elements.push(<Fragment key={id}>{rendered}</Fragment>);
    i = j;
  }
  return { elements, hidden };
}

function DocumentView({ doc, me }: { doc: HipaaDocument; me?: Me | null }) {
  const overrides = doc.slug === "workforce-training" ? trainingSections(me) : {};
  const { elements, hidden } = renderSections(doc, overrides);
  const toc = doc.children.flatMap((n, k) => (n.type === "h" && n.level === 1 && !hidden.has(`s${k}`) ? [{ id: `s${k}`, text: n.text }] : []));
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
        {elements}
        <footer className="doc-foot">Confidential. Internal use only.</footer>
      </article>
    </div>
  );
}

function IndexView({ me }: { me?: Me | null }) {
  return (
    <>
      <p className="eyebrow">HIPAA documentation</p>
      <h1 className="docs-index-title">Compliance documents</h1>
      <p className="docs-intro">
        The three documents the clinic keeps for the {brand.productName}: what the risks are and how they are controlled, the rules staff and
        administrators follow, and the training every user completes before their first sign-in. Read them here, or download the Word files for
        the clinic's records. Nothing needs to be signed.
      </p>
      <div className="docs-cards">
        {documents.map((d) => (
          <section className="docs-card" key={d.slug} aria-labelledby={`card-${d.slug}`}>
            <h2 id={`card-${d.slug}`}>{d.title}</h2>
            <p>{d.summary}</p>
            <div className="docs-card-actions">
              {me && d.slug === "workforce-training" && (
                <a className="btn btn-primary" href="/training" onClick={go("/training")}>
                  Start the course
                </a>
              )}
              <a className={me && d.slug === "workforce-training" ? "btn" : "btn btn-primary"} href={`/documentation/${d.slug}`} onClick={go(`/documentation/${d.slug}`)}>
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
          <li>Fill in the bracketed names and dates in the risk analysis and the policies, and have the Privacy Officer, the Security Officer and the owner approve them. No signatures are needed.</li>
          <li>Every user completes the training inside the assistant before their first conversation; the training log on the Administration page records it.</li>
          <li>Keep the documents with the clinic's compliance records for at least six years, and review them every year or after any major change.</li>
        </ol>
      </section>
    </>
  );
}

/** Public documentation: the HIPAA documents, readable on screen and downloadable as Word files. */
export function DocumentationPage({ backLabel, backTo, me }: Props) {
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
      <main className="docs-main">{doc ? <DocumentView doc={doc} me={me} /> : <IndexView me={me} />}</main>
    </div>
  );
}
