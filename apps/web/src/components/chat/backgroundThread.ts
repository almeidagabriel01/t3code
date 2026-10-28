import { createContext } from "react";

/** True for a background-mounted thread or a side chat; its global shortcuts stand down. */
export const BackgroundThreadContext = createContext(false);
