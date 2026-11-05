/**
 * A phone number as `+` and digits (spaces, dashes, dots and parentheses are dropped) or an email
 * lowercased. Anything else is not a handle: a number without its country code is ambiguous.
 */
export function normalizeHandle(raw: string): string | undefined {
  const value = raw.trim();
  if (value.includes("@")) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value.toLowerCase() : undefined;
  }
  const phone = value.replace(/[\s\-().]/g, "");
  return /^\+[1-9]\d{5,14}$/.test(phone) ? phone : undefined;
}

/** Messages records its own login as `E:me@example.com` or `P:+15551234567`. */
export function ownHandlesFrom(raw: ReadonlyArray<string | null>): ReadonlyArray<string> {
  const out = new Set<string>();
  for (const value of raw) {
    const handle = value === null ? undefined : normalizeHandle(value.replace(/^[EP]:/i, ""));
    if (handle !== undefined) out.add(handle);
  }
  return [...out];
}
