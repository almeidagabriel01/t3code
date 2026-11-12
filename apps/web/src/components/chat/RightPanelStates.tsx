import { Spinner } from "../ui/spinner";

/** A loading line for a right-panel list. */
export function RightPanelLoading(props: { readonly label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
      <Spinner />
      {props.label}
    </p>
  );
}

/** An empty, unavailable or failed state for a right-panel list. */
export function RightPanelMessage(props: {
  readonly title: string;
  readonly detail: string;
  readonly alert?: boolean;
}) {
  return (
    <div role={props.alert ? "alert" : "status"} className="grid gap-1 px-3 py-6 text-center">
      <p className="text-sm font-medium text-foreground">{props.title}</p>
      <p className="text-xs text-muted-foreground">{props.detail}</p>
    </div>
  );
}
