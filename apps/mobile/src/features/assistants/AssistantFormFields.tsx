import type { MenuAction } from "@react-native-menu/menu";
import type { ReactNode } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";

/** A label and one line of help above whatever the form asks. */
export function FieldHeader(props: { readonly label: string; readonly description: string }) {
  return (
    <View className="gap-0.5 px-2">
      <Text textRole="footnote" className="font-t3-medium text-foreground">
        {props.label}
      </Text>
      <Text textRole="footnote" className="text-foreground-muted">
        {props.description}
      </Text>
    </View>
  );
}

/** One row of a single-choice (radio) or multi-choice (checkbox) checkmark list. */
export function ChoiceRow(props: {
  readonly role: "radio" | "checkbox";
  readonly icon?: AppSymbolName;
  readonly leading?: ReactNode;
  readonly label: string;
  readonly description?: string;
  readonly descriptionTruncatesStart?: boolean;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <RowPressable
      disabled={props.disabled}
      accessibilityRole={props.role}
      accessibilityLabel={props.label}
      accessibilityHint={props.description}
      accessibilityState={{ selected: props.selected, checked: props.selected }}
      onPress={props.onPress}
      className="bg-grouped-card"
    >
      <ListRowLayout
        icon={props.icon}
        leading={props.leading}
        label={props.label}
        description={props.description}
        descriptionTruncatesStart={props.descriptionTruncatesStart}
        disabled={props.disabled}
        accessory={
          props.role === "checkbox" ? (
            <SymbolView
              name={props.selected ? "checkmark.circle.fill" : "circle"}
              size={20}
              tintColorClassName={props.selected ? "accent-icon" : "accent-icon-subtle"}
              type="monochrome"
            />
          ) : props.selected ? (
            <SymbolView
              name="checkmark"
              size={16}
              tintColorClassName="accent-icon"
              type="monochrome"
              weight="semibold"
            />
          ) : undefined
        }
      />
    </RowPressable>
  );
}

export function Field(props: {
  readonly label: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="gap-0.5 px-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground">
          {props.label}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {props.description}
        </Text>
      </View>
      <View className="overflow-hidden rounded-2xl bg-grouped-card px-4 py-3">
        {props.children}
      </View>
      {props.footer}
    </View>
  );
}

export function TextField(props: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength?: number;
  readonly multiline?: boolean;
  readonly autoCapitalize?: "none" | "sentences";
  readonly keyboardType?: "decimal-pad" | "number-pad";
  readonly footer?: ReactNode;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}) {
  return (
    <Field label={props.label} description={props.description} footer={props.footer}>
      <TextInput
        accessibilityLabel={props.label}
        placeholder={props.placeholder}
        value={props.value}
        readOnly={props.disabled}
        onChangeText={props.onChange}
        maxLength={props.maxLength}
        multiline={props.multiline}
        autoCapitalize={props.autoCapitalize}
        keyboardType={props.keyboardType}
        autoCorrect={false}
        textAlignVertical={props.multiline ? "top" : "center"}
        placeholderTextColorClassName="accent-foreground-muted"
        className={
          props.multiline
            ? "min-h-36 font-sans text-base text-foreground"
            : "min-h-8 font-sans text-base text-foreground"
        }
      />
    </Field>
  );
}

export function SwitchRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <View className="bg-grouped-card">
      <ListRowLayout
        icon={props.icon}
        label={props.label}
        accessory={
          <ThemedSwitch
            accessibilityLabel={props.label}
            value={props.value}
            onValueChange={props.onChange}
          />
        }
      />
    </View>
  );
}

export function MenuField(props: {
  readonly label: string;
  readonly description: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly footer?: ReactNode;
}) {
  return (
    <Field label={props.label} description={props.description} footer={props.footer}>
      <Menu
        actions={props.actions}
        onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.label}, ${props.value}`}
          className="min-h-8 flex-row items-center gap-3 active:opacity-70"
        >
          <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
            {props.value}
          </Text>
          <SymbolView
            name="chevron.down"
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </Pressable>
      </Menu>
    </Field>
  );
}
