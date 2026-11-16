/** The account page's fixed text; Clerk draws the rest natively. */
export const ACCOUNT_COPY = { connectPage: "T3 Connect" } as const;

export const ACCOUNT_PAGE_LABELS: readonly string[] = [
  ...Object.values(ACCOUNT_COPY),
  // Clerk's native sheet draws these, out of reach of a copy constant.
  "sign in",
  "sign out",
];
