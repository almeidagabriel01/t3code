export const PROJECT_OVERVIEW_COPY = {
  title: "Projects",
  project: { title: "Project", name: "Name" },
  organize: {
    title: "Organize",
    offline: "Connect every machine with this project to change this.",
    pin: {
      title: "Pin",
      description: "Pinned projects come first in project pickers.",
    },
    archive: {
      title: "Archive project",
      description: "Hides the project from project pickers. Threads and files are kept.",
    },
    unarchive: {
      title: "Unarchive project",
      description: "Hidden from project pickers. Threads and files are kept.",
    },
  },
  checkouts: { title: "Checkouts" },
  danger: {
    title: "Danger",
    removeCheckout: {
      title: "Remove checkout",
      description:
        "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched.",
    },
    removeEverywhere: { title: "Remove this project everywhere" },
    remove: {
      title: "Remove project",
      description: "Deletes the project entry and its threads. Files on disk are not touched.",
    },
  },
} as const;

const copy = PROJECT_OVERVIEW_COPY;

export const PROJECTS_PAGE_LABELS: readonly string[] = [
  copy.title,
  copy.project.title,
  copy.project.name,
  copy.organize.title,
  copy.organize.pin.title,
  copy.organize.offline,
  copy.organize.pin.description,
  copy.organize.archive.title,
  copy.organize.archive.description,
  copy.organize.unarchive.title,
  copy.organize.unarchive.description,
  copy.checkouts.title,
  copy.danger.title,
  copy.danger.removeCheckout.title,
  copy.danger.removeCheckout.description,
  copy.danger.removeEverywhere.title,
  copy.danger.remove.title,
  copy.danger.remove.description,
  // The page's name on web.
  "overview",
];
