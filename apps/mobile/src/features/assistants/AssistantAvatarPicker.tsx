import { ASSISTANT_ROBOT_HUES } from "@t3tools/client-runtime/assistantRobot";
import type { Assistant, EnvironmentId } from "@t3tools/contracts";
import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import type { AssistantDraft } from "./assistantDraft";
import { pickAvatarImage } from "./assistantAvatarUpload";
import { FieldHeader } from "./AssistantFormFields";
import { AssistantRobot } from "./AssistantRobot";
import { AssistantAvatar } from "./assistantPresentation";

const ROBOT_VARIANTS = 8;

type AvatarChange = Pick<AssistantDraft, "avatar" | "avatarImage">;

/** Eight robot colors, a shuffle for the robot's shape, or the user's own picture. */
export function AssistantAvatarPicker(props: {
  readonly value: AvatarChange;
  readonly assistant: Pick<Assistant, "id" | "avatar" | "icon"> | null;
  readonly environmentId: EnvironmentId;
  readonly onChange: (next: AvatarChange) => void;
}) {
  const { value } = props;
  const [problem, setProblem] = useState<string | null>(null);
  const robotSelected = value.avatarImage === null;

  const upload = async () => {
    const picked = await pickAvatarImage();
    setProblem(picked.problem);
    if (picked.image !== null) {
      props.onChange({ ...value, avatarImage: { kind: "file", file: picked.image } });
    }
  };

  return (
    <View className="gap-2">
      <FieldHeader
        label="Avatar"
        description="Pick a color, shuffle the face, or upload your own image."
      />
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-1">
        {ASSISTANT_ROBOT_HUES.map((hue) => {
          const selected = robotSelected && value.avatar.hue === hue;
          return (
            <Pressable
              key={hue}
              accessibilityRole="radio"
              accessibilityLabel={`Color ${hue}`}
              accessibilityState={{ selected }}
              onPress={() => {
                setProblem(null);
                props.onChange({ avatar: { ...value.avatar, hue }, avatarImage: null });
              }}
              className={cn(
                "size-12 items-center justify-center rounded-2xl border-2 active:opacity-70",
                selected ? "border-primary" : "border-transparent",
              )}
            >
              <AssistantRobot look={{ hue, variant: value.avatar.variant }} size={38} />
            </Pressable>
          );
        })}
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          label="Shuffle"
          icon="arrow.clockwise"
          size="compact"
          onPress={() =>
            props.onChange({
              avatar: { ...value.avatar, variant: (value.avatar.variant + 1) % ROBOT_VARIANTS },
              avatarImage: null,
            })
          }
        />
        <Button label="Upload image" icon="photo" size="compact" onPress={() => void upload()} />
        {value.avatarImage === null ? null : (
          <>
            <View
              testID="avatar-image-preview"
              className="size-12 items-center justify-center rounded-2xl border-2 border-primary"
            >
              {value.avatarImage.kind === "file" ? (
                <Image
                  accessibilityLabel="Chosen avatar"
                  source={{ uri: value.avatarImage.file.previewUri }}
                  contentFit="cover"
                  style={{ width: 38, height: 38, borderRadius: 11 }}
                />
              ) : props.assistant === null ? null : (
                <AssistantAvatar
                  assistant={props.assistant}
                  environmentId={props.environmentId}
                  size={38}
                />
              )}
            </View>
            <Button
              label="Remove image"
              icon="trash"
              tone="text"
              size="compact"
              onPress={() => {
                setProblem(null);
                props.onChange({ ...value, avatarImage: null });
              }}
            />
          </>
        )}
      </View>
      {problem === null ? null : (
        <Text accessibilityRole="alert" textRole="footnote" className="px-2 text-danger-foreground">
          {problem}
        </Text>
      )}
    </View>
  );
}
