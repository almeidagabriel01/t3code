import { createGlobalSkillsEnvironmentAtoms } from "@t3tools/client-runtime/state/global-skills";

import { connectionAtomRuntime } from "../connection/runtime";

export const globalSkillsEnvironment = createGlobalSkillsEnvironmentAtoms(connectionAtomRuntime);
