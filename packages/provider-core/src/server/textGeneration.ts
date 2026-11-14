import type {
  GenerateMemorySummaryInput,
  GenerateMemorySummaryOutcome,
  ResolveMemoryConflictExecutionResult,
  ResolveMemoryConflictInput,
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  ProjectId,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type { ThreadTitleForkSource } from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  threadContext?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  cwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

export interface AssistantGroupRoutingInput {
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
  readonly groupName: string;
  readonly members: ReadonlyArray<{
    readonly id: string;
    readonly handle: string;
    readonly name: string;
    readonly role: string;
    readonly instructions: string;
  }>;
  readonly recentMessages: ReadonlyArray<{ readonly from: string; readonly text: string }>;
  readonly request: string;
  /** What was said in the request since it was posted (a question about it, the answer). */
  readonly followUps?: ReadonlyArray<{ readonly from: string; readonly text: string }>;
  /** The group's compacted summary of earlier chat, when it has one. */
  readonly summary?: string | null;
  /** The projects to pick from; empty when the request's project is already set. */
  readonly projects?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The message starts a request: name it. */
  readonly newRequest?: boolean;
}

export interface AssistantGroupRoutingResult {
  readonly assistantIds: ReadonlyArray<string>;
  /** The message asks for nothing (thanks, an acknowledgement): with no ids, nobody is given a task. */
  readonly noReply?: boolean;
  /** One of the listed projects; empty when none was listed or it is unclear which. */
  readonly projectId?: string;
  /** When the project is unclear: a short question for the user naming the options. */
  readonly question?: string;
  /** A new request's short title; empty otherwise. */
  readonly title?: string;
}

export interface AssistantGroupSummaryInput {
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
  readonly groupName: string;
  /** The rolling summary so far; null for the first one. */
  readonly previousSummary: string | null;
  /** Oldest first: what was said since that summary. */
  readonly messages: ReadonlyArray<{ readonly from: string; readonly text: string }>;
}

export interface AssistantGroupSummaryResult {
  readonly summary: string;
}

export interface TranscriptionPostProcessingInput {
  cwd: string;
  prompt: string;
  modelSelection: ModelSelection;
}

export interface TranscriptionPostProcessingResult {
  transcription: string;
}

export interface ProviderTextGeneration {
  readonly generateTranscriptionPostProcessing: (
    input: TranscriptionPostProcessingInput,
  ) => Effect.Effect<TranscriptionPostProcessingResult, TextGenerationError>;

  /** Folds new group chat into a rolling summary; offered with `routeAssistantGroup`. */
  readonly summarizeAssistantGroup?: (
    input: AssistantGroupSummaryInput,
  ) => Effect.Effect<AssistantGroupSummaryResult, TextGenerationError>;
  /** Which members of an assistant group a message is for; only some providers can route. */
  readonly routeAssistantGroup?: (
    input: AssistantGroupRoutingInput,
  ) => Effect.Effect<AssistantGroupRoutingResult, TextGenerationError>;
  readonly resolveMemoryConflict?: (
    input: ResolveMemoryConflictInput,
  ) => Effect.Effect<ResolveMemoryConflictExecutionResult, TextGenerationError>;
  readonly generateMemorySummary?: (
    input: GenerateMemorySummaryInput,
  ) => Effect.Effect<GenerateMemorySummaryOutcome, TextGenerationError>;
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;
}

export type {
  ResolveMemoryConflictInput,
  ResolveMemoryConflictResult,
  ResolveMemoryConflictExecutionResult,
  GenerateMemorySummaryInput,
  GenerateMemorySummaryResult,
  GenerateMemorySummaryExecutionResult,
  GenerateMemorySummaryOutcome,
  MemoryGenerationExecution,
} from "@t3tools/contracts";
