import { ListActionRow } from "../../components/ui/ListActionRow";
import type { ArchivedProjectItem } from "./archivedThreadList";

export function ArchivedProjectRow(props: {
  readonly item: ArchivedProjectItem;
  readonly canUnarchive: boolean;
  readonly onUnarchive: (item: ArchivedProjectItem) => void;
}) {
  return (
    <ListActionRow
      icon="archivebox"
      label={props.item.title}
      description="Unarchive project"
      disabled={!props.canUnarchive}
      onPress={() => props.onUnarchive(props.item)}
    />
  );
}
