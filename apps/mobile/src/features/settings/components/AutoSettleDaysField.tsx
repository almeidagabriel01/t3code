import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { NumberField } from "../../../components/ui/NumberField";
import { AUTO_SETTLE_COPY } from "../threadSettingsCopy";

export type AutoSettleDaysFieldProps = Pick<
  ComponentProps<typeof NumberField>,
  "value" | "onValueChange" | "disabled"
>;

export function AutoSettleDaysField(props: AutoSettleDaysFieldProps) {
  return (
    <NumberField
      {...props}
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      label={AUTO_SETTLE_COPY.inactiveDays.sheetTitle}
      formatValue={(value) => `${value} ${value === 1 ? "day" : "days"}`}
    />
  );
}
