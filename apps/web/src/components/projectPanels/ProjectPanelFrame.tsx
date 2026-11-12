import type { ReactNode } from "react";

/** Header and scroll area shared by the project panels (Activity, Memory, Heavy work). */
export function ProjectPanelFrame(props: {
  readonly title: string;
  /** Short count line beside the title, such as "3 items". */
  readonly summary?: string | null;
  readonly actions?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="@container/project-panel flex h-full min-h-0 flex-col">
      <div
        className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2"
        data-glass-layer
      >
        <h2 className="min-w-0 truncate text-sm font-medium">{props.title}</h2>
        {props.summary ? (
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {props.summary}
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-0.5">{props.actions}</span>
      </div>
      {props.toolbar}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5 @md/project-panel:px-2">
        {props.children}
      </div>
    </div>
  );
}
