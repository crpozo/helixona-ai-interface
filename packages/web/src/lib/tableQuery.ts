/**
 * Rules the model writes for the rows of an attached spreadsheet, evaluated here in the browser
 * over the whole file (the model may have seen only part of it):
 *
 *   {{file: Claims.xlsx | where: Status = Open; Paid Amount > 0 | group: Patient | max: Paid Amount, Allowed Amount}}
 *   {{file: Claims.xlsx | group: Patient | pick: highest Paid Amount}}      one whole row per patient
 *   {{file: Claims.xlsx | where: Payer contains Aetna | sort: DOS desc | top: 50 | columns: Patient, DOS, Paid Amount}}
 *
 * Cells are the texts Excel shows; numbers, amounts, percentages and dates are recognised for
 * comparing, sorting and totals, and the original text is kept in the output.
 */

export type Op = "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "not contains" | "starts with" | "ends with" | "is empty" | "is not empty" | "in";
export interface Condition {
  column: string;
  op: Op;
  value: string;
}
export type AggFn = "max" | "min" | "sum" | "avg" | "count";
export interface TableRule {
  where: Condition[];
  group: string[] | null;
  aggregates: Array<{ fn: AggFn; column: string | null }>;
  /** One whole row per group: the one with the highest or lowest value of a column. */
  pick: { fn: "highest" | "lowest"; column: string } | null;
  sort: { column: string; desc: boolean } | null;
  columns: string[] | null;
  top: number | null;
}

export const emptyRule = (): TableRule => ({ where: [], group: null, aggregates: [], pick: null, sort: null, columns: null, top: null });

export function hasRule(r: TableRule): boolean {
  return r.where.length > 0 || r.group !== null || r.aggregates.length > 0 || r.pick !== null || r.sort !== null || r.columns !== null || r.top !== null;
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Reads one "key: value" option of a reference into the rule; false when the key is not a rule option. */
export function applyRuleOption(rule: TableRule, key: string, value: string): boolean {
  const k = key.trim().toLowerCase().replace(/\s+/g, " ");
  const v = value.trim();
  switch (k) {
    case "where":
    case "filter":
    case "only": {
      for (const part of v.split(";")) {
        const c = parseCondition(part);
        if (c) rule.where.push(c);
      }
      return true;
    }
    case "group":
    case "group by":
    case "per":
    case "by":
      rule.group = [...(rule.group ?? []), ...list(v)];
      return true;
    case "max":
    case "highest":
    case "largest":
      for (const c of list(v)) rule.aggregates.push({ fn: "max", column: c });
      return true;
    case "min":
    case "lowest":
    case "smallest":
      for (const c of list(v)) rule.aggregates.push({ fn: "min", column: c });
      return true;
    case "sum":
    case "total":
      for (const c of list(v)) rule.aggregates.push({ fn: "sum", column: c });
      return true;
    case "avg":
    case "average":
    case "mean":
      for (const c of list(v)) rule.aggregates.push({ fn: "avg", column: c });
      return true;
    case "count":
      rule.aggregates.push({ fn: "count", column: null });
      return true;
    case "pick": {
      const m = /^(highest|lowest|max|min|largest|smallest|latest|earliest|first|last)\s+(.+)$/i.exec(v);
      if (m) rule.pick = { fn: /^(highest|max|largest|latest|last)$/i.test(m[1]!) ? "highest" : "lowest", column: m[2]!.trim() };
      return true;
    }
    case "sort":
    case "order":
    case "order by":
    case "sort by": {
      const m = /^(.+?)(?:\s+(asc|ascending|desc|descending|up|down))?$/i.exec(v);
      if (m) rule.sort = { column: m[1]!.trim(), desc: /^(desc|descending|down)$/i.test(m[2] ?? "") };
      return true;
    }
    case "columns":
    case "column":
    case "show":
    case "select":
      rule.columns = list(v);
      return true;
    case "top":
    case "limit":
    case "first": {
      const n = Number(v.replace(/[^\d]/g, ""));
      if (Number.isFinite(n) && n > 0) rule.top = Math.floor(n);
      return true;
    }
    default:
      return false;
  }
}

export function parseCondition(text: string): Condition | null {
  const t = text.trim();
  if (!t) return null;
  let m = /^(.+?)\s+(is not empty|is empty|not contains|does not contain|doesn't contain|contains|starts with|begins with|ends with|is not|is|in|not in|equals)\b\s*:?\s*(.*)$/i.exec(t);
  if (m) {
    const word = m[2]!.toLowerCase();
    const op: Op =
      word === "is not empty" ? "is not empty"
        : word === "is empty" ? "is empty"
          : word === "contains" ? "contains"
            : word === "not contains" || word === "does not contain" || word === "doesn't contain" ? "not contains"
              : word === "starts with" || word === "begins with" ? "starts with"
                : word === "ends with" ? "ends with"
                  : word === "is not" || word === "not in" ? "!="
                    : word === "in" ? "in"
                      : "=";
    return { column: m[1]!.trim(), op: word === "not in" ? "!=" : op, value: unquote(m[3] ?? "") };
  }
  m = /^(.+?)\s*(>=|<=|!=|<>|=|>|<)\s*(.*)$/.exec(t);
  if (m) {
    const sym = m[2]! === "<>" ? "!=" : (m[2]! as Op);
    return { column: m[1]!.trim(), op: sym, value: unquote(m[3] ?? "") };
  }
  return null;
}

function unquote(s: string): string {
  const t = s.trim();
  return /^".*"$|^'.*'$/.test(t) ? t.slice(1, -1) : t.replace(/^\(|\)$/g, "").trim();
}

// ---------------------------------------------------------------- cell values

/** "$1,234.50" → 1234.5; "($20.00)" → -20; "12.5%" → 12.5; "" or text → null. */
export function cellNumber(s: string): number | null {
  let t = s.trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1).trim();
  }
  if (t.startsWith("-")) {
    neg = !neg;
    t = t.slice(1).trim();
  }
  t = t.replace(/^[$€£]\s*/, "").replace(/%$/, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** m/d/yyyy (with an optional time), yyyy-mm-dd or an ISO date → milliseconds; else null. */
export function cellDate(s: string): number | null {
  const t = s.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(t);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    let h = Number(m[4] ?? 0);
    const ap = (m[7] ?? "").toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    const d = new Date(y, Number(m[1]) - 1, Number(m[2]), h, Number(m[5] ?? 0), Number(m[6] ?? 0));
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Compares two cells the way staff would: as numbers or dates when both are, else as text. */
export function compareCells(a: string, b: string): number {
  const na = cellNumber(a);
  const nb = cellNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const da = cellDate(a);
  const db = cellDate(b);
  if (da !== null && db !== null) return da - db;
  return norm(a).localeCompare(norm(b), "en", { numeric: true });
}

function matches(cell: string, c: Condition): boolean {
  const v = cell.trim();
  const want = c.value.trim();
  switch (c.op) {
    case "is empty":
      return v === "";
    case "is not empty":
      return v !== "";
    case "contains":
      return norm(v).includes(norm(want));
    case "not contains":
      return !norm(v).includes(norm(want));
    case "starts with":
      return norm(v).startsWith(norm(want));
    case "ends with":
      return norm(v).endsWith(norm(want));
    case "in":
      return list(want).some((w) => sameValue(v, w));
    case "=":
      return sameValue(v, want);
    case "!=":
      return want.includes(",") ? !list(want).some((w) => sameValue(v, w)) : !sameValue(v, want);
    case ">":
      return v !== "" && compareCells(v, want) > 0;
    case ">=":
      return v !== "" && compareCells(v, want) >= 0;
    case "<":
      return v !== "" && compareCells(v, want) < 0;
    case "<=":
      return v !== "" && compareCells(v, want) <= 0;
  }
}

function sameValue(a: string, b: string): boolean {
  const na = cellNumber(a);
  const nb = cellNumber(b);
  if (na !== null && nb !== null) return na === nb;
  const da = cellDate(a);
  const db = cellDate(b);
  if (da !== null && db !== null) return da === db;
  return norm(a) === norm(b);
}

/** The column a name points to: the same name (ignoring case and spacing), else the only column containing it. */
export function findColumn(header: string[], name: string): number {
  const n = norm(name);
  if (!n) return -1;
  const exact = header.findIndex((h) => norm(h) === n);
  if (exact >= 0) return exact;
  const partial = header.map((h, i) => (norm(h).includes(n) ? i : -1)).filter((i) => i >= 0);
  return partial.length === 1 ? partial[0]! : -1;
}

/** A total formatted like the cells it came from: money stays money, percentages stay percentages. */
export function formatLike(samples: string[], n: number): string {
  const money = samples.some((s) => /[$€£]/.test(s));
  const percent = samples.length > 0 && samples.every((s) => /%\s*$/.test(s.trim()) || s.trim() === "");
  const decimals = Math.min(4, samples.reduce((d, s) => Math.max(d, (/\.(\d+)/.exec(s.replace(/[%$€£,\s]/g, ""))?.[1] ?? "").length), 0));
  const digits = money ? 2 : decimals;
  const text = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, money ? 2 : 0) });
  const sign = n < 0 ? "-" : "";
  if (money) return `${sign}${(samples.find((s) => /[$€£]/.test(s)) ?? "$").match(/[$€£]/)![0]}${text}`;
  if (percent) return `${sign}${text}%`;
  return `${sign}${text}`;
}

export interface RuleResult {
  rows: string[][];
  problems: string[];
}

const AGG_LABEL: Record<AggFn, string> = { max: "Highest", min: "Lowest", sum: "Total", avg: "Average", count: "Rows" };

/** Applies a rule to a sheet (header plus data rows) and returns the resulting table (header first). */
export function applyRule(header: string[], data: string[][], rule: TableRule, fileName: string): RuleResult {
  const problems: string[] = [];
  const col = (name: string): number => {
    const i = findColumn(header, name);
    if (i < 0) problems.push(`"${fileName}" has no column named "${name}".`);
    return i;
  };
  const conditions = rule.where.map((c) => ({ ...c, index: col(c.column) }));
  const groupCols = (rule.group ?? []).map((g) => col(g));
  const aggregates = rule.aggregates.map((a) => ({ ...a, index: a.column === null ? -1 : col(a.column) }));
  const pickIndex = rule.pick ? col(rule.pick.column) : -1;
  if (problems.length > 0) return { rows: [], problems };

  let rows = data.filter((r) => conditions.every((c) => matches(r[c.index] ?? "", c)));
  let out: string[][];
  if (groupCols.length > 0 || (aggregates.length > 0 && !rule.pick)) {
    const groups = new Map<string, { key: string[]; rows: string[][] }>();
    for (const r of rows) {
      const key = groupCols.map((i) => r[i] ?? "");
      const id = key.map(norm).join("\u0000");
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { key: key.map((k) => k.trim()), rows: [] }));
      g.rows.push(r);
    }
    if (rule.pick) {
      const extreme = (list: string[][]) =>
        list.reduce((best, r) => {
          const a = r[pickIndex] ?? "";
          if (a.trim() === "") return best;
          if (best === null) return r;
          const cmp = compareCells(a, best[pickIndex] ?? "");
          return (rule.pick!.fn === "highest" ? cmp > 0 : cmp < 0) ? r : best;
        }, null as string[] | null);
      out = [header, ...[...groups.values()].map((g) => extreme(g.rows) ?? g.rows[0]!)];
    } else {
      const aggs = aggregates.length > 0 ? aggregates : [{ fn: "count" as AggFn, column: null, index: -1 }];
      const head = [...groupCols.map((i) => header[i] ?? ""), ...aggs.map((a) => (a.fn === "count" ? "Rows" : `${AGG_LABEL[a.fn]} ${header[a.index] ?? ""}`))];
      const line = (g: { key: string[]; rows: string[][] }) => [
        ...g.key,
        ...aggs.map((a) => {
          if (a.fn === "count") return String(g.rows.length);
          const cells = g.rows.map((r) => r[a.index] ?? "").filter((c) => c.trim() !== "");
          if (cells.length === 0) return "";
          if (a.fn === "max" || a.fn === "min") return cells.reduce((best, c) => ((a.fn === "max" ? compareCells(c, best) > 0 : compareCells(c, best) < 0) ? c : best));
          const nums = cells.map(cellNumber).filter((n): n is number => n !== null);
          if (nums.length === 0) return "";
          const total = nums.reduce((s, n) => s + n, 0);
          return formatLike(cells, a.fn === "sum" ? total : total / nums.length);
        }),
      ];
      out = groupCols.length > 0 ? [head, ...[...groups.values()].map(line)] : [head, line({ key: [], rows })];
    }
  } else {
    out = [header, ...rows];
  }

  const [head, ...body] = out;
  let result = body;
  if (rule.sort) {
    const i = findColumn(head!, rule.sort.column);
    if (i < 0) problems.push(`The result has no column named "${rule.sort.column}" to sort by.`);
    else {
      const dir = rule.sort.desc ? -1 : 1;
      result = [...result].sort((a, b) => dir * compareCells(a[i] ?? "", b[i] ?? ""));
    }
  }
  if (rule.top !== null) result = result.slice(0, rule.top);
  if (rule.columns) {
    const idx = rule.columns.map((c) => {
      const i = findColumn(head!, c);
      if (i < 0) problems.push(`The result has no column named "${c}".`);
      return i;
    });
    if (idx.every((i) => i >= 0)) return { rows: [idx.map((i) => head![i] ?? ""), ...result.map((r) => idx.map((i) => r[i] ?? ""))], problems };
  }
  return { rows: [head!, ...result], problems };
}

/** A short description of a rule, for notes ("where Status = Open, per Patient, highest Paid Amount"). */
export function describeRule(rule: TableRule): string {
  const parts: string[] = [];
  if (rule.where.length > 0) parts.push(`where ${rule.where.map((c) => `${c.column} ${c.op} ${c.value}`.trim()).join(" and ")}`);
  if (rule.group) parts.push(`per ${rule.group.join(", ")}`);
  if (rule.pick) parts.push(`the row with the ${rule.pick.fn} ${rule.pick.column}`);
  for (const a of rule.aggregates) parts.push(a.fn === "count" ? "count" : `${AGG_LABEL[a.fn].toLowerCase()} ${a.column}`);
  if (rule.sort) parts.push(`sorted by ${rule.sort.column}${rule.sort.desc ? " descending" : ""}`);
  if (rule.top !== null) parts.push(`first ${rule.top}`);
  return parts.join(", ");
}
