const searchable = (value: string) => value.normalize("NFC").toLocaleLowerCase();

/** Every whitespace-separated term must appear in the title, preview, or path. */
export function filterNotes<T extends { title: string; preview: string; path: string }>(
  notes: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const terms = searchable(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return notes;
  return notes.filter((note) => {
    const haystack = searchable(`${note.title}\n${note.preview}\n${note.path}`);
    return terms.every((term) => haystack.includes(term));
  });
}
