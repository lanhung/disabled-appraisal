export function normalizeForMatching(value = '') {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

export function includesNormalizedText(source, quote) {
  const normalizedQuote = normalizeForMatching(quote);
  return Boolean(normalizedQuote) && normalizeForMatching(source).includes(normalizedQuote);
}
