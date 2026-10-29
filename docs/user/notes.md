# Notes

Notes are markdown files you and your agents can both read and edit: plans, checklists,
research, screenshots.

## Start a note

Open **Notes** from the icon rail on the left or the command palette, or press `mod+alt+o` on web
and desktop when the terminal is not focused. On the Notes page, `mod+n` creates a note and `/`
jumps to search. Change the shortcuts under **Notes: Open** and **Notes: New** in
**Settings → Keybindings**.

A new note starts as `Untitled.md` and saves as you type. Its first heading becomes its title.
Pin a note to keep it at the top of the list. Use **Rename or move…** to name the file or put it in
a folder; folders go one level deep and show as groups in the list. The palette's **Search notes**
finds a note by title.

When more than one connected environment has notes, pick the environment at the top of the page.
Each environment keeps its own notes.

## Images

Paste, drop, or pick an image with the image button in the toolbar. It appears at once and uploads
in the background; the note saves the image after the upload finishes.

## Start work

**Start work** turns a note into a card on a project's board, with the note as the card's
description, and links the two. T3 Code suggests the project named like the note's folder,
otherwise the project you used most recently. Choose a column, or leave the default.

When the card is ready you can open it or start an agent on it. The note then shows the card, its
column, and **Unlink**. If the card is deleted, the note says so and you can unlink it.

## Notes and threads

The notes button in a thread's header lists the notes linked to that thread. Link an existing note,
unlink one, or create a note for the thread. A linked note lists the thread under **Related threads**.

## Where notes live

Notes are plain `.md` files on the machine that runs the T3 Code server, in the `notes` folder of
its data directory (`~/.t3/userdata/notes` by default). T3 Code keeps pin, card, and thread links in
a small frontmatter block at the top of each file.

You can edit the files in any editor. T3 Code picks up the change, and if you were editing the same
note, it asks you to compare the two versions before saving. Markdown the editor cannot show, such
as tables or HTML, stays as source text, and parts you did not touch are saved exactly as they were.
