import { vi } from "vite-plus/test";

/** Replaces modules a test does not exercise with stubs, so a component under test can import them. */
export function stubModules(fromDir: string, specifiers: ReadonlyArray<string>) {
  for (const specifier of specifiers) {
    const target = specifier.startsWith(".")
      ? new URL(specifier, `file://${fromDir}/`).pathname
      : specifier;
    vi.doMock(target, () => {
      const stub = vi.fn();
      return new Proxy(
        {},
        {
          get: (_, key) => (key === "then" || key === "__esModule" ? undefined : stub),
          has: () => true,
        },
      );
    });
  }
}
