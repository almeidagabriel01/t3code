// What a page that reads environments says while none is selected, shared by web and mobile.

export const CONNECT_ENVIRONMENT_FOR_PROVIDERS = "Connect an environment to set up its providers.";
export const CONNECT_ENVIRONMENT_FOR_MCP_SERVERS =
  "Connect an environment to manage its MCP servers.";
export const CONNECT_ENVIRONMENT_FOR_T3_SKILLS = "Connect an environment to manage its T3 skills.";
/** Mobile shows MCP servers and skills on one page. */
export const CONNECT_ENVIRONMENT_FOR_MCP_SERVERS_AND_SKILLS =
  "Connect an environment to manage its MCP servers and skills.";
export const CONNECT_ENVIRONMENT_FOR_THREAD_SETTINGS =
  "Connect an environment to change its thread settings.";
export const CONNECT_ENVIRONMENT_FOR_SOURCE_CONTROL_SETTINGS =
  "Connect an environment to change its source control settings.";
export const CONNECT_ENVIRONMENT_FOR_WORKTREE_SETTINGS =
  "Connect an environment to change its worktree settings.";
export const CONNECT_ENVIRONMENT_FOR_MAINTENANCE_SETTINGS =
  "Connect an environment to change its maintenance settings.";
export const CONNECT_ENVIRONMENT_FOR_SCHEDULED_TASKS =
  "Connect an environment to manage scheduled tasks.";
export const CONNECT_ENVIRONMENT_TO_CREATE_SCHEDULED_TASK =
  "Connect an environment to create a scheduled task.";
export const CONNECT_ENVIRONMENT_FOR_DIAGNOSTICS = "Connect an environment to see diagnostics.";
export const CONNECT_ENVIRONMENT_FOR_KEYBINDINGS = "Connect an environment to change keybindings.";
export const CONNECT_ENVIRONMENT_FOR_SECRET_PROVIDERS =
  "Connect an environment to manage the secret providers its provider variables read from.";
export const CONNECT_ENVIRONMENT_FOR_CONNECTION_SETTINGS =
  "Connect an environment to view its settings and access.";
export const CONNECT_ENVIRONMENT_FOR_VOICE_MODEL = "Connect an environment first.";

/** @public Mobile reads it through `emptyEnvironmentSelectionText`. */
export const NO_MATCHING_ENVIRONMENTS =
  "No environments match this filter. Change the filter above.";

/** No environment at all asks for one; environments the filter hides point at the filter. */
export function emptyEnvironmentSelectionText(
  connectEnvironment: string,
  environmentsAvailable: boolean,
): string {
  return environmentsAvailable ? NO_MATCHING_ENVIRONMENTS : connectEnvironment;
}

export type UsageSubject = "limits" | "usage";

export function connectEnvironmentToSee(subject: UsageSubject): string {
  return `Connect an environment to see ${subject}.`;
}

export function selectEnvironmentToSee(subject: UsageSubject): string {
  return `Select an environment to see ${subject}.`;
}
