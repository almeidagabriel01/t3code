import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

export const APP_SIGN_IN_HOSTS = sourceControlClients.definitions.flatMap((definition) =>
  definition.credentials?.appSignIn === undefined
    ? []
    : [{ definition, appSignIn: definition.credentials.appSignIn }],
);

export const APP_SIGN_IN_COPY = {
  signedIn: "Signed in",
  starting: "Starting…",
  signIn: "Sign in",
} as const;
