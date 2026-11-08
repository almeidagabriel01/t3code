import {
  isMemoryRule,
  MEMORY_RULE_PREFIX,
  repositoryGroupingKeyOf,
  stripMemoryRulePrefix,
  type MemoryItem,
  type ScopedThreadRef,
  type MemoryListInput,
  type MemoryPage,
  type MemoryProjectBinding,
  type MemoryScope,
  type MemorySearchInput,
  type RepositoryIdentity,
} from "@t3tools/contracts";

// Indexed phrase search works at every supported scope size, unlike bounded substring scans.
const MEMORY_SEARCH_MODE = "fts" satisfies MemorySearchInput["mode"];

/** Call only after binding lookup succeeds: a failed lookup cannot rule out an explicit key. */
export function memoryProjectScope(
  binding: Pick<MemoryProjectBinding, "projectKey" | "repositoryKey">,
  repositoryIdentity: RepositoryIdentity | null | undefined,
): MemoryScope | null {
  const projectKey =
    binding.projectKey ??
    binding.repositoryKey ??
    (repositoryIdentity
      ? { kind: "repository" as const, groupingKey: repositoryGroupingKeyOf(repositoryIdentity) }
      : null);
  return projectKey ? { kind: "project", projectKey } : null;
}

type BrowseInput = Omit<MemoryListInput, "includeQuarantined">;

export function memoryBrowseInput(input: BrowseInput) {
  return { ...input, scope: input.scope ?? { kind: "user" as const } };
}

export function memorySearchInput(input: BrowseInput, query: string): MemorySearchInput {
  return { ...memoryBrowseInput(input), query: query.trim(), mode: MEMORY_SEARCH_MODE };
}

export function presentMemoryPage(page: MemoryPage, searching: boolean) {
  if (searching && page.indexCoverage && page.indexCoverage.status !== "available") {
    return "Results are incomplete; memories may still be available";
  }
  if (page.items.length > 0) return null;
  if (page.nextCursor) return "No matching memories on this page. Continue to the next page.";
  return searching ? "No memories found" : "No memories yet.";
}

export function memoryPreview(text: string) {
  let preview = "";
  let length = 0;
  for (const character of text) {
    if (length++ === 120) break;
    preview += character;
  }
  return preview;
}

export function memoryScopeLabel(scope: MemoryScope) {
  return scope.kind === "user" ? "User" : scope.kind === "project" ? "Project" : "Thread";
}

export type MemoryRuleItem = Extract<MemoryItem, { status: "active" }>;

/** An active user or project memory whose text carries the rule marker. */
function isMemoryRuleItem(item: MemoryItem): item is MemoryRuleItem {
  return (
    item.status === "active" &&
    (item.scope.kind === "user" || item.scope.kind === "project") &&
    isMemoryRule(item.payload.text)
  );
}

/** Rules newest first. A page holds at most the first 100 memories of a scope (ponytail: no server rule filter yet). */
export function memoryRules(items: readonly MemoryItem[]): MemoryRuleItem[] {
  return items
    .filter(isMemoryRuleItem)
    .sort((a, b) => b.revision.createdAtUtc.localeCompare(a.revision.createdAtUtc));
}

export function withoutMemoryRules(items: readonly MemoryItem[]): MemoryItem[] {
  return items.filter((item): boolean => !isMemoryRuleItem(item));
}

export const memoryRuleText = (item: MemoryRuleItem) => stripMemoryRulePrefix(item.payload.text);

/** Rules are saved as the prefix plus the text the user sees. */
export const memoryRuleBody = (text: string) => MEMORY_RULE_PREFIX + stripMemoryRulePrefix(text);

/** How long the "rule saved" notice stays before it leaves by itself. */
export const LEARNED_RULE_VISIBLE_MS = 8_000;

export function memoryRuleScopeLabel(scope: MemoryScope) {
  return scope.kind === "user" ? "All projects" : "This project";
}

/** Rules whose evidence cites the given thread. */
export function memoryRulesLearnedIn(items: readonly MemoryItem[], thread: ScopedThreadRef) {
  return memoryRules(items).filter((item) =>
    item.payload.evidence.some(
      (e) =>
        e.sourceThread?.environmentId === thread.environmentId &&
        e.sourceThread.threadId === thread.threadId,
    ),
  );
}
