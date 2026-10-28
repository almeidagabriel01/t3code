import type { GlobalBoard, GlobalFilters } from "@t3tools/client-runtime/state/kanbanLogic";
import {
  boardScopeKey,
  EMPTY_FILTERS,
  KANBAN_PRIORITIES,
} from "@t3tools/client-runtime/state/kanbanLogic";
import { BotIcon, ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { KanbanProjectInfo } from "./KanbanProjectBadge";
import { PRIORITY_LABELS } from "./kanbanPresentation";

const ANY = "__any__";

function FilterTrigger(props: {
  readonly label: string;
  readonly valueLabel: string | null;
  readonly children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={props.label}
        render={<Button size="xs" variant={props.valueLabel === null ? "outline" : "secondary"} />}
      >
        {props.valueLabel === null ? props.label : `${props.label}: ${props.valueLabel}`}
        <ChevronDownIcon aria-hidden className="text-muted-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="start" side="bottom">
        {props.children}
      </MenuPopup>
    </Menu>
  );
}

function RadioFilter(props: {
  readonly label: string;
  readonly value: string | null;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onChange: (value: string | null) => void;
}) {
  const selected = props.options.find((option) => option.value === props.value);
  return (
    <FilterTrigger label={props.label} valueLabel={selected?.label ?? null}>
      <MenuRadioGroup
        value={props.value ?? ANY}
        onValueChange={(next) => props.onChange(next === ANY ? null : next)}
      >
        <MenuRadioItem value={ANY}>Any</MenuRadioItem>
        {props.options.map((option) => (
          <MenuRadioItem key={option.value} value={option.value}>
            {option.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </FilterTrigger>
  );
}

function activeFilterCount(filters: GlobalFilters): number {
  return (
    filters.projects.length +
    (filters.label !== null ? 1 : 0) +
    (filters.priority !== null ? 1 : 0) +
    (filters.type !== null ? 1 : 0) +
    (filters.hasAgent ? 1 : 0) +
    (filters.text.trim().length > 0 ? 1 : 0)
  );
}

export function KanbanGlobalFilters(props: {
  readonly filters: GlobalFilters;
  readonly boards: ReadonlyArray<GlobalBoard>;
  readonly projects: ReadonlyMap<string, KanbanProjectInfo>;
  readonly layout: "merged" | "lanes";
  readonly onFilters: (next: GlobalFilters) => void;
  readonly onLayout: (layout: "merged" | "lanes") => void;
}) {
  const { filters, boards } = props;
  const patch = (next: Partial<GlobalFilters>) => props.onFilters({ ...filters, ...next });
  const labelNames = [...new Set(boards.flatMap(({ board }) => board.labels.map((l) => l.name)))];
  const typeNames = [...new Set(boards.flatMap(({ board }) => board.templates.map((t) => t.name)))];
  const active = activeFilterCount(filters);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
      <InputGroup className="w-56">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search cards"
          placeholder="Search cards"
          value={filters.text}
          onChange={(event) => patch({ text: event.target.value })}
        />
      </InputGroup>
      <FilterTrigger
        label="Projects"
        valueLabel={filters.projects.length > 0 ? String(filters.projects.length) : null}
      >
        {boards.map(({ environmentId, board }) => {
          const key = boardScopeKey(environmentId, board.projectId);
          const info = props.projects.get(key);
          return (
            <MenuCheckboxItem
              key={key}
              checked={filters.projects.includes(key)}
              onCheckedChange={(checked) =>
                patch({
                  projects: checked
                    ? [...filters.projects, key]
                    : filters.projects.filter((entry) => entry !== key),
                })
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                {info ? <ProjectFavicon project={info.project} className="size-4" /> : null}
                <span className="truncate">{info?.name ?? board.title}</span>
              </span>
            </MenuCheckboxItem>
          );
        })}
      </FilterTrigger>
      <RadioFilter
        label="Label"
        value={filters.label}
        options={labelNames.map((value) => ({ value, label: value }))}
        onChange={(label) => patch({ label })}
      />
      <RadioFilter
        label="Priority"
        value={filters.priority}
        options={KANBAN_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] }))}
        onChange={(priority) => patch({ priority: priority as GlobalFilters["priority"] })}
      />
      <RadioFilter
        label="Type"
        value={filters.type}
        options={typeNames.map((value) => ({ value, label: value }))}
        onChange={(type) => patch({ type })}
      />
      <Button
        size="xs"
        variant={filters.hasAgent ? "secondary" : "outline"}
        aria-pressed={filters.hasAgent}
        onClick={() => patch({ hasAgent: !filters.hasAgent })}
      >
        <BotIcon />
        Has agent
      </Button>
      {active > 0 ? (
        <Button size="xs" variant="ghost-muted" onClick={() => props.onFilters(EMPTY_FILTERS)}>
          <XIcon />
          Clear ({active})
        </Button>
      ) : null}
      <ToggleGroup
        aria-label="Layout"
        className="ms-auto"
        value={[props.layout]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "merged" || value === "lanes") props.onLayout(value);
        }}
      >
        <Toggle value="merged">By status</Toggle>
        <Toggle value="lanes">By project</Toggle>
      </ToggleGroup>
    </div>
  );
}
