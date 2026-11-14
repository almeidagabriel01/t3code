/** A project title on one line: newlines, tabs and runs of spaces become one space. */
export const projectNoticeTitle = (title: string): string => title.replace(/\s+/g, " ").trim();

/** The project a chat-app message is about, in brackets before its text. */
export const projectNoticePrefix = (title: string, text: string): string =>
  `[${projectNoticeTitle(title)}] ${text}`;
