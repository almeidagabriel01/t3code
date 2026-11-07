import { useId } from "react";

import {
  assistantRobotSpec,
  type AssistantMood,
  type AssistantRobotLook,
  type AssistantRobotSpec,
} from "@t3tools/client-runtime/assistantRobot";
import { cn } from "~/lib/utils";

function Eyes({ spec }: { readonly spec: AssistantRobotSpec }) {
  switch (spec.eyes) {
    case "focused":
      return (
        <path
          d="M25 37q4-5 8 0M39 37q4-5 8 0"
          stroke={spec.eyeColor}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
        />
      );
    case "alert":
      return (
        <>
          <circle cx={29} cy={36} r={4.2} fill={spec.eyeColor} />
          <circle cx={43} cy={36} r={4.2} fill={spec.eyeColor} />
        </>
      );
    case "crossed":
      return (
        <path
          d="M26 33l6 6M32 33l-6 6M40 33l6 6M46 33l-6 6"
          stroke={spec.eyeColor}
          strokeWidth={2.6}
          strokeLinecap="round"
        />
      );
    case "open":
      return (
        <>
          <rect x={25} y={33} width={8} height={6} rx={3} fill={spec.eyeColor} />
          <rect x={39} y={33} width={8} height={6} rx={3} fill={spec.eyeColor} />
        </>
      );
  }
}

function Antenna({ spec }: { readonly spec: AssistantRobotSpec }) {
  const stem = {
    stroke: spec.light,
    strokeOpacity: 0.75,
    strokeWidth: 2.4,
    strokeLinecap: "round" as const,
  };
  switch (spec.antenna) {
    case "single":
      return (
        <>
          <line x1={36} y1={10} x2={36} y2={18} {...stem} />
          <circle cx={36} cy={9} r={3.4} fill={spec.tipColor} />
        </>
      );
    case "double":
      return (
        <>
          <line x1={28} y1={12} x2={30} y2={19} {...stem} />
          <line x1={44} y1={12} x2={42} y2={19} {...stem} />
          <circle cx={27.5} cy={10.5} r={2.8} fill={spec.tipColor} />
          <circle cx={44.5} cy={10.5} r={2.8} fill={spec.tipColor} />
        </>
      );
    case "ring":
      return (
        <>
          <line x1={36} y1={14} x2={36} y2={19} {...stem} />
          <circle cx={36} cy={10} r={4} fill="none" stroke={spec.tipColor} strokeWidth={2.4} />
        </>
      );
    case "none":
      return <rect x={30} y={15} width={12} height={4} rx={2} fill={spec.tipColor} opacity={0.9} />;
  }
}

/** The assistant's robot: an original drawing whose face follows what the assistant is doing. */
export function AssistantRobot(props: {
  readonly look: AssistantRobotLook;
  readonly mood?: AssistantMood;
  readonly className?: string;
}) {
  const spec = assistantRobotSpec(props.look, props.mood ?? "idle");
  const id = useId();
  return (
    <svg
      aria-hidden
      viewBox="0 0 72 72"
      data-assistant-robot={props.mood ?? "idle"}
      className={cn("size-6 shrink-0", props.className)}
    >
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={spec.gradientFrom} />
          <stop offset="1" stopColor={spec.gradientTo} />
        </linearGradient>
        <radialGradient id={`${id}-shine`} cx=".3" cy=".2" r=".7">
          <stop offset="0" stopColor={spec.light} stopOpacity={0.55} />
          <stop offset="1" stopColor={spec.light} stopOpacity={0} />
        </radialGradient>
      </defs>
      <rect x={2} y={2} width={68} height={68} rx={20} fill={`url(#${id}-body)`} />
      <rect x={2} y={2} width={68} height={68} rx={20} fill={`url(#${id}-shine)`} />
      <Antenna spec={spec} />
      {spec.ears ? (
        <>
          <rect x={9} y={31} width={6} height={12} rx={3} fill={spec.light} fillOpacity={0.6} />
          <rect x={57} y={31} width={6} height={12} rx={3} fill={spec.light} fillOpacity={0.6} />
        </>
      ) : null}
      <rect x={16} y={22} width={40} height={30} rx={13} fill={spec.visor} opacity={0.88} />
      <rect x={18} y={24} width={36} height={7} rx={3.5} fill={spec.light} opacity={0.08} />
      <Eyes spec={spec} />
      <path
        d="M30 46q6 3 12 0"
        stroke={spec.light}
        strokeOpacity={0.55}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}
