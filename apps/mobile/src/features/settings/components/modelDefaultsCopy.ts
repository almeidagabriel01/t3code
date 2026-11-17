/** The fixed text of the project model, fallback model and folder model sections. */
export const PROJECT_MODEL_COPY = {
  model: { title: "Model", description: "Model for new threads in this project." },
  byAssistant: {
    title: "Model by assistant",
    description: "These assistants start new threads in this project on their own model.",
  },
  checkoutsDiffer: { description: "The checkouts differ. Pick one model for all of them." },
  selectedAutomatically: { description: "Selected automatically." },
  sources: {
    project: "Set for this project.",
    folder: "From a folder rule.",
    environment: "Follows the environment's default model.",
    "t3.json": "From the repository's t3.json.",
  },
} as const;

export const FALLBACK_MODELS_COPY = {
  title: "Fallback models",
  mixed: "These environments differ. Select one to edit its fallback models.",
  editable: "Tried in order for new threads when the default model's provider is out of usage.",
  readOnly: "Select one environment to edit its fallback models.",
} as const;

export const FOLDER_MODELS_COPY = {
  title: "Model by folder",
  mixed: "These environments differ. Select one to edit its folder models.",
  editable:
    "Projects inside a folder start new threads with its model; a project's own setting still wins.",
  readOnly: "Select one environment to edit its folder models.",
} as const;
