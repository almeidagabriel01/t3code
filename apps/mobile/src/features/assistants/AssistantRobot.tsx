import {
  assistantRobotSpec,
  type AssistantMood,
  type AssistantRobotLook,
  type AssistantRobotSpec,
} from "@t3tools/client-runtime/assistantRobot";
import { useId } from "react";
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

function Eyes({ spec }: { readonly spec: AssistantRobotSpec }) {
  switch (spec.eyes) {
    case "focused":
      return (
        <Path
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
          <Circle cx={29} cy={36} r={4.2} fill={spec.eyeColor} />
          <Circle cx={43} cy={36} r={4.2} fill={spec.eyeColor} />
        </>
      );
    case "crossed":
      return (
        <Path
          d="M26 33l6 6M32 33l-6 6M40 33l6 6M46 33l-6 6"
          stroke={spec.eyeColor}
          strokeWidth={2.6}
          strokeLinecap="round"
        />
      );
    case "open":
      return (
        <>
          <Rect x={25} y={33} width={8} height={6} rx={3} fill={spec.eyeColor} />
          <Rect x={39} y={33} width={8} height={6} rx={3} fill={spec.eyeColor} />
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
          <Line x1={36} y1={10} x2={36} y2={18} {...stem} />
          <Circle cx={36} cy={9} r={3.4} fill={spec.tipColor} />
        </>
      );
    case "double":
      return (
        <>
          <Line x1={28} y1={12} x2={30} y2={19} {...stem} />
          <Line x1={44} y1={12} x2={42} y2={19} {...stem} />
          <Circle cx={27.5} cy={10.5} r={2.8} fill={spec.tipColor} />
          <Circle cx={44.5} cy={10.5} r={2.8} fill={spec.tipColor} />
        </>
      );
    case "ring":
      return (
        <>
          <Line x1={36} y1={14} x2={36} y2={19} {...stem} />
          <Circle cx={36} cy={10} r={4} fill="none" stroke={spec.tipColor} strokeWidth={2.4} />
        </>
      );
    case "none":
      return <Rect x={30} y={15} width={12} height={4} rx={2} fill={spec.tipColor} opacity={0.9} />;
  }
}

/** The assistant's robot, drawn from the same spec as web; its face follows what it is doing. */
export function AssistantRobot(props: {
  readonly look: AssistantRobotLook;
  readonly mood?: AssistantMood;
  readonly size: number;
}) {
  const mood = props.mood ?? "idle";
  const spec = assistantRobotSpec(props.look, mood);
  const id = useId();
  return (
    <Svg
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={`assistant-robot-${mood}`}
      width={props.size}
      height={props.size}
      viewBox="0 0 72 72"
    >
      <Defs>
        <LinearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={spec.gradientFrom} />
          <Stop offset="1" stopColor={spec.gradientTo} />
        </LinearGradient>
        <RadialGradient id={`${id}-shine`} cx=".3" cy=".2" r=".7">
          <Stop offset="0" stopColor={spec.light} stopOpacity={0.55} />
          <Stop offset="1" stopColor={spec.light} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x={2} y={2} width={68} height={68} rx={20} fill={`url(#${id}-body)`} />
      <Rect x={2} y={2} width={68} height={68} rx={20} fill={`url(#${id}-shine)`} />
      <Antenna spec={spec} />
      {spec.ears ? (
        <>
          <Rect x={9} y={31} width={6} height={12} rx={3} fill={spec.light} fillOpacity={0.6} />
          <Rect x={57} y={31} width={6} height={12} rx={3} fill={spec.light} fillOpacity={0.6} />
        </>
      ) : null}
      <Rect x={16} y={22} width={40} height={30} rx={13} fill={spec.visor} opacity={0.88} />
      <Rect x={18} y={24} width={36} height={7} rx={3.5} fill={spec.light} opacity={0.08} />
      <Eyes spec={spec} />
      <Path
        d="M30 46q6 3 12 0"
        stroke={spec.light}
        strokeOpacity={0.55}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
    </Svg>
  );
}
