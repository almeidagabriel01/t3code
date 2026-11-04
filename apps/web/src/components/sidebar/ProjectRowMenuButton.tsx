import { EllipsisIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { Button } from "../ui/button";

/** The always-visible ⋯ that opens a project row's menu; it takes the row's right edge when nothing else does. */
export function ProjectRowMenuButton(props: {
  readonly name: string;
  readonly takesRightEdge: boolean;
  readonly onOpen: (event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      tabIndex={-1}
      aria-label={`Actions for ${props.name}`}
      title={`Actions for ${props.name}`}
      className={props.takesRightEdge ? "ml-auto" : undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={props.onOpen}
    >
      <EllipsisIcon className="size-3.5" />
    </Button>
  );
}
