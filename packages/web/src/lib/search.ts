/** Case- and accent-insensitive match of every word of the query against a title ("eob mar" finds "EOBs March"). */
export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function matchesQuery(text: string, query: string): boolean {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = normalizeText(text);
  return words.every((w) => hay.includes(w));
}
