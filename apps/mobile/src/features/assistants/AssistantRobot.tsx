import {
  ASSISTANT_DONE_MS,
  assistantRobotSpec,
  faceOfMood,
  type AssistantFace,
  type AssistantMood,
  type AssistantRobotLook,
  type AssistantRobotSpec,
} from "@t3tools/client-runtime/assistantRobot";
import { useEffect, useId, useState } from "react";
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";

import { useAppForeground, useReduceMotionEnabled } from "../../lib/appState";

/** Avatars below this size stay still: the motion would be a speck. */
const MOTION_MIN_SIZE = 24;
/** One short beat every few seconds; React renders twice per period, nothing in between. */
const MOTION_PERIOD_MS = 2600;
const MOTION_BEAT_MS = { blink: 160, glance: 900, think: 700 } as const;

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
    case "closed":
      return (
        <Path
          d="M25 36h8M39 36h8"
          stroke={spec.eyeColor}
          strokeWidth={2.6}
          fill="none"
          strokeLinecap="round"
        />
      );
    case "happy":
      return (
        <Path
          d="M25 38q4-6 8 0M39 38q4-6 8 0"
          stroke={spec.eyeColor}
          strokeWidth={3}
          fill="none"
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

/** "Done" is a brief beat: it shows for a few seconds, then the robot is simply idle. */
function useFace(requested: AssistantFace): AssistantFace {
  const [doneOver, setDoneOver] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one timer ends the done beat without a parent re-render
  useEffect(() => {
    if (requested !== "done") return;
    const timer = setTimeout(() => setDoneOver(true), ASSISTANT_DONE_MS);
    return () => {
      clearTimeout(timer);
      setDoneOver(false);
    };
  }, [requested]);
  return requested === "done" && doneOver ? "idle" : requested;
}

/** True for a short beat each period while the app is in the foreground and motion is allowed. */
function useBeat(motion: "blink" | "glance" | "think"): boolean {
  const foreground = useAppForeground();
  const reduced = useReduceMotionEnabled();
  const [beat, setBeat] = useState(false);
  const running = foreground && !reduced;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sparse timer that drives the robot's occasional beat
  useEffect(() => {
    if (!running) return;
    let end: ReturnType<typeof setTimeout> | undefined;
    const start = setInterval(() => {
      setBeat(true);
      end = setTimeout(() => setBeat(false), MOTION_BEAT_MS[motion]);
    }, MOTION_PERIOD_MS);
    return () => {
      clearInterval(start);
      clearTimeout(end);
      setBeat(false);
    };
  }, [running, motion]);
  return running && beat;
}

function MovingRobot(props: {
  readonly look: AssistantRobotLook;
  readonly face: AssistantFace;
  readonly motion: "blink" | "glance" | "think";
  readonly size: number;
}) {
  const beat = useBeat(props.motion);
  return <RobotDrawing look={props.look} face={props.face} size={props.size} beat={beat} />;
}

/** The assistant's robot, drawn from the same spec as web; its face follows what it is doing. */
export function AssistantRobot(props: {
  readonly look: AssistantRobotLook;
  readonly mood?: AssistantMood | AssistantFace;
  readonly size: number;
}) {
  const face = useFace(faceOfMood(props.mood ?? "idle"));
  const { motion } = assistantRobotSpec(props.look, face);
  if (motion !== null && props.size >= MOTION_MIN_SIZE) {
    return <MovingRobot look={props.look} face={face} motion={motion} size={props.size} />;
  }
  return <RobotDrawing look={props.look} face={face} size={props.size} beat={false} />;
}

function RobotDrawing(props: {
  readonly look: AssistantRobotLook;
  readonly face: AssistantFace;
  readonly size: number;
  readonly beat: boolean;
}) {
  const { face, beat } = props;
  const spec = assistantRobotSpec(props.look, face);
  const eyesTransform = !beat
    ? undefined
    : spec.motion === "blink"
      ? "translate(0 36) scale(1 0.1) translate(0 -36)"
      : spec.motion === "glance"
        ? "translate(-2 0)"
        : undefined;
  const id = useId();
  return (
    <Svg
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={`assistant-robot-${face}`}
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
      <G opacity={beat && spec.motion === "think" ? 0.35 : 1}>
        <Antenna spec={spec} />
      </G>
      {spec.ears ? (
        <>
          <Rect x={9} y={31} width={6} height={12} rx={3} fill={spec.light} fillOpacity={0.6} />
          <Rect x={57} y={31} width={6} height={12} rx={3} fill={spec.light} fillOpacity={0.6} />
        </>
      ) : null}
      <Rect x={16} y={22} width={40} height={30} rx={13} fill={spec.visor} opacity={0.88} />
      <Rect x={18} y={24} width={36} height={7} rx={3.5} fill={spec.light} opacity={0.08} />
      <G testID="assistant-robot-eyes" {...(eyesTransform ? { transform: eyesTransform } : {})}>
        <Eyes spec={spec} />
      </G>
      <Path
        d="M30 46q6 3 12 0"
        stroke={spec.light}
        strokeOpacity={0.55}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
      {spec.badge?.kind === "dot" ? (
        <Circle cx={60} cy={12} r={8} fill={spec.badge.color} stroke={spec.visor} strokeWidth={3} />
      ) : null}
      {spec.badge?.kind === "ring" ? (
        <Rect
          x={2}
          y={2}
          width={68}
          height={68}
          rx={20}
          fill="none"
          stroke={spec.badge.color}
          strokeWidth={4}
        />
      ) : null}
    </Svg>
  );
}
