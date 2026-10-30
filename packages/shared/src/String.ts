export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}

/** At most `max` UTF-16 units, never ending on half of a surrogate pair. */
export function sliceWholeCodePoints(text: string, max: number): string {
  const cut = text.slice(0, max);
  return text.length > max && /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut;
}
