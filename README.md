# Club Votes

Your club's place to decide things together. Anyone in the club posts a
decision (a question, with optional details), everyone votes yes, no or
maybe, the discussion happens in the comments underneath, and whoever
posted it closes the vote when the club has decided. Closed votes keep
their result — passed, did not pass, or tied — in the Closed tab.

## How it works

- One screen of open-decision cards: each shows the live tally bar (a
  show of hands), the yes/no/maybe counts, how many members haven't
  voted, whether you've voted, and the comment count. Tap a card for the
  decision itself.
- The decision screen has the vote buttons (changeable any time while
  it's open), the comment thread, and — for whoever posted it — the
  Close vote action and Delete.
- Counting is simple yes or no, most wins: more yes than no passes, more
  no than yes doesn't, and an equal count is a tie. Maybe never counts.
- Anyone can report someone else's decision or comment; reports go to a
  private table the group's admins can look at.

## Development

`npm start` runs the server; `npm run build` compiles the Tailwind
stylesheet. To change the app, ask Homeroom bot (open the app on Homeroom,
tap the Homeroom icon, then **Suggest an improvement**) or run Claude Code
against this repo — start with `CLAUDE.md`, which carries the app-specific
notes and points at the platform rules.

Staging previews show a populated board at `?demo=1`: a sample chess club,
seeded once per viewer, visible only to them.
