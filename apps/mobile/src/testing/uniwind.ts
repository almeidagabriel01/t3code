// uniwind only runs under Metro; its Node ESM build does not load. Tests that need styles mock it themselves.
import type { ReactNode } from "react";

const Passthrough = (props: { readonly children?: ReactNode }) => props.children;

export const ScopedTheme = Passthrough;
export const ScopedVariables = Passthrough;
export const Uniwind = { updateCSSVariables: () => undefined };
// oxlint-disable-next-line t3code/no-hookless-use-function -- stands in for uniwind's hook by name
export const useResolveClassNames = () => ({});
export const withUniwind = <T>(component: T) => component;
