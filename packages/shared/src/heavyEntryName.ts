const NAME_CHARS = 32;

const base = (path: string) => path.split(/[\\/]/).findLast((part) => part !== "") ?? path;

/** The name a person gave the entry, else a readable one derived from its command and folder. */
export function heavyEntryName(entry: {
  readonly name?: string | undefined;
  readonly label: string;
  readonly cwd: string;
}): string {
  const given = entry.name?.trim();
  if (given) return given;
  const words = entry.label.trim().split(/\s+/);
  const command = [base(words[0] ?? ""), ...words.slice(1)].join(" ");
  const where = base(entry.cwd);
  const install = /\bmobile:install\s+(ios|android)\b/i.exec(command);
  if (install) return `Install ${install[1]!.toLowerCase() === "ios" ? "iOS" : "Android"} app`;
  if (/\b(vp|vitest)\b.*\btest\b|\bvitest\b/.test(command)) {
    return where ? `Tests · ${where}` : "Tests";
  }
  if (/\btypecheck\b/.test(command)) return where ? `Typecheck · ${where}` : "Typecheck";
  if (/\bcheck:changed\b/.test(command)) return "Changed checks";
  const text = words
    .slice(0, 3)
    .map((word, i) => (i === 0 ? base(word) : word))
    .join(" ");
  return text.length > NAME_CHARS ? `${text.slice(0, NAME_CHARS - 1)}…` : text;
}
