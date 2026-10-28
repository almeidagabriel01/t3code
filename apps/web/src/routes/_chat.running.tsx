import { createFileRoute } from "@tanstack/react-router";

import { RunningPage } from "../components/running/RunningPage";

export const Route = createFileRoute("/_chat/running")({ component: RunningPage });
