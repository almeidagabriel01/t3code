/** Holds menu changes while the menu is open: replacing an open menu closes it. */
export function createTrayMenuGate<M>(initial: M, apply: (menu: M) => void) {
  let open = false;
  let latest = initial;
  let applied: string | null = null;
  const flush = () => {
    if (open) return;
    const key = JSON.stringify(latest);
    if (key === applied) return;
    applied = key;
    apply(latest);
  };
  return {
    update: (menu: M) => {
      latest = menu;
      flush();
    },
    opened: () => {
      open = true;
    },
    closed: () => {
      open = false;
      flush();
    },
    /** A new tray needs the menu again. */
    reapply: () => {
      applied = null;
      flush();
    },
  };
}
