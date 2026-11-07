import {
  ASSISTANT_AVATAR_MAX_BYTES,
  ASSISTANT_AVATAR_MIME_TYPES,
  type Assistant,
} from "@t3tools/contracts";
import { ASSISTANT_ROBOT_HUES } from "@t3tools/client-runtime/assistantRobot";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { ImageUpIcon, ShuffleIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import { AssistantRobot } from "./AssistantRobot";
import { AssistantAvatar } from "./assistantPresentation";

export type AvatarDraft = {
  readonly hue: number;
  readonly variant: number;
  /** The stored picture kept as is, a file waiting for Save, or none (the robot). */
  readonly image:
    | { readonly kind: "stored" }
    | { readonly kind: "file"; readonly file: File; readonly previewUrl: string }
    | null;
};

const ROBOT_VARIANTS = 8;

/** Why a file cannot be an avatar, or null. The server checks the bytes again. */
function avatarFileProblem(file: File): string | null {
  if (!(ASSISTANT_AVATAR_MIME_TYPES as ReadonlyArray<string>).includes(file.type.toLowerCase())) {
    return "Use a PNG, JPEG or WebP image.";
  }
  if (file.size > ASSISTANT_AVATAR_MAX_BYTES) {
    return `The image must be under ${ASSISTANT_AVATAR_MAX_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

// The tile is one padding wider than the robot, so the inset outline frames it without covering it.
const TILE_CLASS =
  "inline-flex size-12 cursor-pointer items-center justify-center rounded-2xl p-1 outline-none hover:bg-foreground/8 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-checked:outline-solid data-checked:outline-2 data-checked:-outline-offset-2 data-checked:outline-primary";

/** Eight robot colors, a shuffle for the robot's shape, or the user's own picture. */
export function AssistantAvatarPicker(props: {
  readonly value: AvatarDraft;
  readonly assistant: Pick<Assistant, "id" | "avatar" | "icon"> | null;
  readonly onChange: (next: AvatarDraft) => void;
}) {
  const { value } = props;
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const robotSelected = value.image === null;

  const pickFile = (file: File | undefined) => {
    if (file === undefined) return;
    const rejected = avatarFileProblem(file);
    setProblem(rejected);
    if (rejected !== null) return;
    // The preview lives until the dialog closes; one small object URL per pick.
    props.onChange({
      ...value,
      image: { kind: "file", file, previewUrl: URL.createObjectURL(file) },
    });
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">Avatar</legend>
      <p className="text-xs text-muted-foreground">
        Pick a color, shuffle the face, or upload your own image.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <RadioGroup
          aria-label="Avatar color"
          className="flex flex-wrap gap-1"
          value={robotSelected ? String(value.hue) : ""}
          onValueChange={(next) => {
            setProblem(null);
            props.onChange({ ...value, hue: Number(next), image: null });
          }}
        >
          {ASSISTANT_ROBOT_HUES.map((hue) => (
            <Radio.Root
              key={hue}
              value={String(hue)}
              aria-label={`Color ${hue}`}
              className={TILE_CLASS}
            >
              <AssistantRobot look={{ hue, variant: value.variant }} className="size-10" />
            </Radio.Root>
          ))}
        </RadioGroup>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() =>
            props.onChange({ ...value, variant: (value.variant + 1) % ROBOT_VARIANTS, image: null })
          }
        >
          <ShuffleIcon />
          Shuffle
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => input.current?.click()}>
          <ImageUpIcon />
          Upload image
        </Button>
        {value.image === null ? null : (
          <>
            <span
              data-avatar-image-preview=""
              className="inline-flex size-12 rounded-2xl p-1 outline-solid outline-2 -outline-offset-2 outline-primary"
            >
              {value.image.kind === "file" ? (
                <img
                  alt="Chosen avatar"
                  src={value.image.previewUrl}
                  className="size-10 rounded-xl object-cover"
                />
              ) : props.assistant === null ? null : (
                <AssistantAvatar assistant={props.assistant} className="size-10" />
              )}
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                setProblem(null);
                props.onChange({ ...value, image: null });
              }}
            >
              <Trash2Icon />
              Remove image
            </Button>
          </>
        )}
        <input
          ref={input}
          type="file"
          hidden
          aria-label="Avatar image file"
          accept={ASSISTANT_AVATAR_MIME_TYPES.join(",")}
          onChange={(event) => {
            pickFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </fieldset>
  );
}
