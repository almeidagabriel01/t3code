import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  integrationCategoryLabel,
  integrationDirectory,
  type IntegrationDirectoryRow,
  type IntegrationMenuAction,
  type IntegrationSourceNote,
} from "@t3tools/client-runtime/integrations";
import { IntegrationCategory, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView as HorizontalScroll, View } from "react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { ListSection } from "../../components/ui/ListSection";
import { RowMenuButton } from "../../components/ui/RowMenuButton";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { Toast } from "../../components/ui/Toast";
import { appAtomRegistry } from "../../state/atom-registry";
import { useIntegrationsEnvironmentIds, useIntegrationsState } from "../../state/integrations";
import { useSettingsEnvironmentMenu } from "../settings/components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import { IntegrationChip, IntegrationIcon } from "./IntegrationParts";
import { connectedNoticeAtom, useIntegrationFlows } from "./useIntegrationFlows";

type Category = typeof IntegrationCategory.Type;
type Flows = ReturnType<typeof useIntegrationFlows>;

// Android draws menu images through AppSymbol's map, so each name must be in it.
const MENU_IMAGES: Readonly<Record<IntegrationMenuAction["kind"], string>> = {
  "make-available": "square.on.square",
  disconnect: "xmark",
  "use-token": "key",
};

function IntegrationRow(props: { readonly row: IntegrationDirectoryRow; readonly flows: Flows }) {
  const { row, flows } = props;
  const navigation = useNavigation();
  const [busy, setBusy] = useState(false);
  const primary = row.primary;
  // Hand-made T3 servers are edited where they were added.
  const onPress =
    primary?.kind === "open"
      ? () => flows.runPrimary(primary)
      : primary === null && row.origins.some((origin) => origin.origin === "t3")
        ? () => navigation.navigate("SettingsAgentTools")
        : null;
  const note = primary?.kind === "connect" && primary.reason !== null ? primary.reason : row.note;
  const body = (
    <View className="min-h-14 flex-row items-center gap-3 py-3 ps-4 pe-2">
      <IntegrationIcon icon={row.icon} />
      <View className="min-w-0 flex-1 gap-1">
        <Text textRole="body" className="text-foreground" numberOfLines={1}>
          {row.title}
        </Text>
        {row.description === "" ? null : (
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {row.description}
          </Text>
        )}
        <View className="flex-row flex-wrap gap-1">
          {row.status !== null ? (
            <IntegrationChip label={row.status.label} tone={row.status.tone} />
          ) : (
            row.origins.map((origin) => (
              <IntegrationChip key={origin.detectedId} label={origin.label} tone="muted" />
            ))
          )}
        </View>
        {note === null ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {note}
          </Text>
        )}
      </View>
      {onPress === null ? null : (
        <SymbolView name="chevron.right" size={13} tintColorClassName="accent-chevron" />
      )}
    </View>
  );
  const run = (action: () => Promise<unknown> | void) => {
    setBusy(true);
    void Promise.resolve(action()).finally(() => setBusy(false));
  };
  const menu: MenuAction[] = row.menu.map((action, index) => ({
    id: String(index),
    title: action.label,
    image: MENU_IMAGES[action.kind],
    ...(action.kind === "disconnect" ? { attributes: { destructive: true } } : {}),
  }));
  return (
    <View className="flex-row items-center bg-grouped-card">
      {onPress === null ? (
        <View className="min-w-0 flex-1">{body}</View>
      ) : (
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={row.title}
          onPress={onPress}
          className="min-w-0 flex-1"
        >
          {body}
        </RowPressable>
      )}
      {primary === null || primary.kind === "open" ? null : primary.kind === "cancel" ? (
        <Button
          label={primary.label}
          size="compact"
          accessibilityLabel={`${primary.label} ${row.title}`}
          disabled={!flows.canAct}
          onPress={() => run(() => flows.runPrimary(primary))}
        />
      ) : (
        <Button
          label={primary.label}
          size="compact"
          accessibilityLabel={`${primary.label} ${row.title}`}
          loading={busy}
          disabled={!flows.canAct || (primary.kind === "connect" && primary.disabled)}
          onPress={() => run(() => flows.connect(primary.catalogId))}
        />
      )}
      {menu.length === 0 ? (
        <View className="w-3" />
      ) : (
        <RowMenuButton
          label={`${row.title} actions`}
          actions={menu}
          onAction={(id) => flows.runMenu(row.menu[Number(id)]!, row.title)}
        />
      )}
    </View>
  );
}

const sourceNoteText = (note: IntegrationSourceNote) =>
  note.reason === null
    ? note.label
    : note.path === null
      ? `${note.label}: ${note.reason}`
      : `${note.label} ${note.path}: ${note.reason}`;

function IntegrationsDirectory(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string | undefined;
  readonly query: string;
  readonly category: Category | null;
}) {
  const navigation = useNavigation();
  const state = useIntegrationsState(props.environmentId);
  const flows = useIntegrationFlows(props.environmentId, state);
  if (state === null) {
    return (
      <View className="items-center py-6">
        <AppActivityIndicator />
      </View>
    );
  }
  const directory = integrationDirectory(state, {
    query: props.query,
    category: props.category,
  });
  const addCustomServer = (
    <Button
      label="Add custom server"
      icon="plus"
      tone="text"
      size="compact"
      onPress={() => navigation.navigate("SettingsAgentTools")}
    />
  );
  const section = (title: string, rows: ReadonlyArray<IntegrationDirectoryRow>) =>
    rows.length === 0 ? null : (
      <ListSection title={title}>
        {rows.map((row) => (
          <IntegrationRow key={row.key} row={row} flows={flows} />
        ))}
      </ListSection>
    );
  return (
    <View className="gap-5">
      {props.title === undefined ? null : (
        <Text textRole="headline" className="px-2 text-foreground">
          {props.title}
        </Text>
      )}
      {directory.connected.length + directory.available.length + directory.other.length === 0 &&
      (props.query.trim() !== "" || props.category !== null) ? (
        <Text className="px-2 text-base text-foreground-muted">
          No integrations match your search.
        </Text>
      ) : null}
      {section("Connected", directory.connected)}
      {section("Available", directory.available)}
      {directory.other.length === 0 ? (
        <View className="flex-row items-center justify-between gap-3 ps-2">
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            Other
          </Text>
          {addCustomServer}
        </View>
      ) : (
        <ListSection title="Other" trailing={addCustomServer}>
          {directory.other.map((row) => (
            <IntegrationRow key={row.key} row={row} flows={flows} />
          ))}
        </ListSection>
      )}
      {directory.sourceNotes.map((note) => (
        <Text
          key={`${note.origin}:${note.instanceId ?? ""}:${note.path ?? ""}`}
          textRole="footnote"
          className={
            note.reason === null ? "px-2 text-foreground-muted" : "px-2 text-warning-foreground"
          }
        >
          {sourceNoteText(note)}
        </Text>
      ))}
    </View>
  );
}

function ConnectedNotice() {
  const notice = useAtomValue(connectedNoticeAtom);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  if (notice === null) return null;
  const dismiss = () => appAtomRegistry.set(connectedNoticeAtom, null);
  return (
    <View
      className="absolute inset-x-4"
      style={{ bottom: Math.max(insets.bottom, 12) + 8 }}
      pointerEvents="box-none"
    >
      <Toast
        message="Choose which assistants use it"
        tone="success"
        dismissMode="swipe"
        onDismiss={dismiss}
        action={{
          label: "Assistants",
          onPress: () => {
            dismiss();
            navigation.navigate("SettingsAssistants");
          },
        }}
      />
    </View>
  );
}

/** Settings → Integrations: the catalog, what is connected, and servers found elsewhere. */
export function SettingsIntegrationsRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const environmentIds = useIntegrationsEnvironmentIds();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const targets = selectedTargets.filter((target) => environmentIds.includes(target.environmentId));
  return (
    <SettingsScreen
      title="Integrations"
      menus={[environmentMenu]}
      search={{
        value: query,
        onChangeText: setQuery,
        placeholder: "Search integrations",
        mode: "inline",
      }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 72 }}
      >
        <HorizontalScroll
          accessibilityLabel="Categories"
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-5"
        >
          {[null, ...IntegrationCategory.literals].map((item) => (
            <Chip
              key={item ?? "all"}
              label={integrationCategoryLabel(item)}
              selected={category === item}
              onPress={() => setCategory(item)}
            />
          ))}
        </HorizontalScroll>
        <View className="gap-8 px-5">
          {targets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              No integrations match your search.
            </Text>
          ) : (
            targets.map((target) => (
              <IntegrationsDirectory
                key={target.environmentId}
                environmentId={target.environmentId}
                title={targets.length > 1 ? target.label : undefined}
                query={query}
                category={category}
              />
            ))
          )}
        </View>
      </ScrollView>
      <ConnectedNotice />
    </SettingsScreen>
  );
}
