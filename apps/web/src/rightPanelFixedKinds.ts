export const FIXED_PANEL_KINDS = ["files", "diff", "terminal", "preview", "pull-requests"] as const;
export type FixedPanelKind = (typeof FIXED_PANEL_KINDS)[number];

export function fixedPanelKindOf(surface: { readonly kind: string }): FixedPanelKind | null {
  switch (surface.kind) {
    case "file":
      return "files";
    case "pull-request":
      return "pull-requests";
    case "files":
    case "diff":
    case "terminal":
    case "preview":
    case "pull-requests":
      return surface.kind;
    default:
      return null;
  }
}
