import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function PromptDialog(props: {
  readonly title: string;
  readonly label: string;
  readonly initial?: string;
  readonly inputType?: "text" | "number";
  readonly submitLabel?: string;
  readonly allowEmpty?: boolean;
  readonly onSubmit: (value: string) => void;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  const canSubmit = props.allowEmpty === true || value.trim().length > 0;
  const submit = () => {
    if (!canSubmit) return;
    props.onSubmit(value.trim());
    props.onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Label htmlFor="kanban-prompt">{props.label}</Label>
            <Input
              id="kanban-prompt"
              autoFocus
              type={props.inputType ?? "text"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {props.submitLabel ?? "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ChoiceDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly submitLabel: string;
  readonly destructive?: boolean;
  readonly onSubmit: (value: string) => void;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState(props.options[0]?.value ?? "");
  const selected = props.options.find((option) => option.value === value);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Select value={value} onValueChange={(next) => next !== null && setValue(next)}>
            <SelectTrigger aria-label="Target">
              <SelectValue>{selected?.label ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {props.options.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant={props.destructive ? "destructive" : "default"}
            disabled={selected === undefined}
            onClick={() => {
              props.onSubmit(value);
              props.onClose();
            }}
          >
            {props.submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function OptionSelect<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly disabled?: boolean;
  readonly onChange: (value: T) => void;
}) {
  const selected = props.options.find((option) => option.value === props.value);
  return (
    <Select
      value={props.value}
      disabled={props.disabled === true}
      onValueChange={(next) => {
        const option = props.options.find((entry) => entry.value === next);
        if (option !== undefined) props.onChange(option.value);
      }}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue>{selected?.label ?? ""}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
