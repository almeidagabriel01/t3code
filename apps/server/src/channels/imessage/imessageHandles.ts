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
