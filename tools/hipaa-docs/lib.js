/**
 * Document model shared by the Word (.docx) and web renderers. Every helper returns plain,
 * JSON-serializable nodes; `render-docx.js` turns them into a Word file and `build.js` writes the
 * same tree as JSON for the web app's Documentation page. Keep the helper names stable: the
 * content files under `content/` are written against them.
 */
const h1 = (text) => ({ type: "h", level: 1, text });
const h2 = (text) => ({ type: "h", level: 2, text });
const h3 = (text) => ({ type: "h", level: 3, text });
const runs = (text) => (Array.isArray(text) ? text : [text]);
/** Paragraph. `text` is a string or a list of strings and `b()`/`i()` runs. */
const p = (text, opts = {}) => ({ type: "p", runs: runs(text), ...opts });
const b = (text) => ({ b: text });
const i = (text) => ({ i: text });
/** Highlighted note (gold left border). */
const note = (text) => ({ type: "note", text });
/** Both list helpers return a one-element array so callers can spread them like before. */
const bullets = (items) => [{ type: "list", ordered: false, items: items.map(runs) }];
const numbered = (items) => [{ type: "list", ordered: true, items: items.map(runs) }];
/** Table with a header row. Cells are strings or arrays of lines; widths are DXA (twentieths of a point). */
const table = (headers, rows, widths) => ({ type: "table", headers, rows, widths });
/** Two-column key/value table without a header row. */
const kv = (rows, widths = [2600, 6760]) => ({ type: "kv", rows, widths });
const signatures = (roles) => ({ type: "signatures", roles });
const spacer = () => ({ type: "spacer" });
const pageBreak = () => ({ type: "pageBreak" });
const FILL_IN_NOTE =
  "Fill in the bracketed fields, review with the clinic's Privacy Officer and Security Officer, and keep the signed copy with the compliance records for at least six years. Legal review is recommended before adoption.";
const titleBlock = (title, subtitle, meta) => [{ type: "title", title, subtitle, meta }, note(FILL_IN_NOTE)];

module.exports = { h1, h2, h3, p, b, i, note, bullets, numbered, table, kv, signatures, spacer, pageBreak, titleBlock };
