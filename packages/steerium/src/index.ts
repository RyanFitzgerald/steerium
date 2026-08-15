/**
 * Public API surface for steerium. Workflow files import from here:
 *
 *   import { defineWorkflow, schedule, linear } from "steerium";
 */

// define* identity helpers
export {
  defineConfig,
  defineConnector,
  defineProvider,
  defineTrigger,
  defineWorkflow,
} from "./define.js";

// Built-in triggers
export { manual } from "./triggers/manual.js";
export { schedule } from "./triggers/schedule.js";
export { pollTrigger } from "./triggers/poll.js";
export type { ScheduleEvent } from "./triggers/schedule.js";
export type { ManualEvent } from "./triggers/manual.js";

// Approvals (human-in-the-loop gates)
export { approvals, isApprove, APPROVALS_NAMESPACE } from "./approvals.js";
export type {
  ApprovalContext,
  ApprovalDisplay,
  ApprovalEvent,
  ApprovalOption,
  ApprovalRecord,
  ApprovalReply,
  ApprovalRequestOptions,
  ApprovalRespondedOptions,
  ApprovalTransport,
  ApprovalTransportContext,
} from "./approvals.js";

// Built-in connectors
export { linear } from "./connectors/linear.js";
export { jira } from "./connectors/jira.js";
export { github } from "./connectors/github.js";
export type { LinearTicket, LinearTicketEvent } from "./connectors/linear.js";
export type { JiraIssue, JiraIssueEvent } from "./connectors/jira.js";
export type {
  GithubIssue,
  GithubIssueEvent,
  GithubPullRequest,
  GithubPullRequestEvent,
} from "./connectors/github.js";

// Built-in providers (registered automatically; exported for reuse/wrapping)
export { mockProvider } from "./providers/mock.js";
export { openaiProvider } from "./providers/openai.js";
export { anthropicProvider } from "./providers/anthropic.js";
export { codexProvider } from "./providers/codex.js";
export { claudeProvider } from "./providers/claude.js";
// Throw this from a provider when a failed call still burned tokens — the
// registry records the attached usage on the error row instead of "unknown".
export { AgentCallError } from "./providers/usage.js";

// Types
export type {
  Agent,
  AgentOutputSchema,
  AgentResult,
  AgentRunOptions,
  AgentUsage,
  ArtifactWriter,
  EnvRef,
  KeyValueState,
  Logger,
  Promisable,
  Provider,
  ProviderConfig,
  ProviderContext,
  ProviderHealth,
  Scope,
  Secret,
  StandardOutputSchema,
  SteeriumConfig,
  StructuredError,
  Trigger,
  TriggerContext,
  TriggerHandle,
  TriggerState,
  WebhookHandler,
  WebhookRequest,
  WebhookResponse,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowProvenance,
} from "./types.js";

// Run/step/event rows and control API response shapes, shared with API
// clients (the browser UI imports these instead of redeclaring them).
export type {
  AgentCallRecord,
  EventRecord,
  RunEventRecord,
  RunRecord,
  RunStatus,
  RunStepRecord,
  StepStatus,
} from "./types.js";
export type {
  ApprovalListing,
  ArtifactInfo,
  FireResult,
  RespondResult,
  WorkflowSummary,
} from "./runtime/control-api.js";
export type { DaemonInfo, ProjectInfo } from "./runtime/daemon.js";
