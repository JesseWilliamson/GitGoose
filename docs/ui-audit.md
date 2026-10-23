# UI audit

Jesse: "do an audit of the UI. Some things look pretty crap. Clean it up and make it look pretty.
Redesign things that don't work. Use design fundamentals. Go back to basics. Keep it clean,
reasonable, functional, beautiful." This is PLAN-5 §7. The audit is split into two PRs:

- **UI audit 1** (this document's "Done" column): the scale and the colour vocabulary, the AI
  surfaces (the pane, the composer, the per-area controls) and the pane tab strip.
- **UI audit 2**: the sidebar, graph lanes, toolbar, Welcome, omni search, dialogs, the diff
  header, status bar and the contrast of hint text.

## How it was done

The app was launched on the dev fixture (`pnpm dev:repo`, 3,000 commits, stashes, branches) at
1280 x 800, in both themes, and every surface was captured: Welcome, the graph (comfy and
compact) with a commit selected, the working copy, Details, the AI pane with a selection chip, a
file diff, omni search (Ctrl+K), a context menu, a dialog (New branch), the toolbar. Each finding
below was read off those captures, not off the code. Where the code explains it, it says so.

What "go back to basics" meant in practice, four questions asked of every surface:

1. **Hierarchy.** What is the one thing this surface is for? Is it the loudest thing on it?
2. **Grouping.** Do things that belong together sit together, in one container, and things that
   do not sit apart? (Proximity does most of the work a border does.)
3. **Consistency.** Is the same thing drawn the same way everywhere? One tab style, one icon
   size, one grey for hints, one height for a row.
4. **Restraint.** Does every always-visible element earn its place now, or only sometimes?
   Things used now and then go behind one quiet control.

## Verdicts on the eight findings

| # | Finding | Verified | Notes |
|---|---|---|---|
| 1 | AI pane: double header, four stacked bars, empty state | Yes | Header "AI ⋯" in the strip and "AI · dev-repo + ⟲" under it. The bottom stack (chips, hint, three rows of wrapped action buttons, selects + Prompt, textarea + Send) was 228 px of a 700 px pane, 33%. |
| 2 | Tab strips: ⋯ always visible, third tab style | Yes | Uppercase 11 px semibold with an inset underline, next to the 13 px title bar tabs and shadcn's `Tabs` pill. |
| 3 | Per-area AI controls dominate | Yes | Two selects and a Prompt button were the only bordered controls in the Details header, the commit box and the pane footer, so they out-shouted Explain / Commit / Send. |
| 4 | Comfy graph, 8 lanes | Partly | Verified in the code, not in a screenshot: a comfy row's lane cell is 6 + lanes x 24 px (`cellWidth` in `GraphCell.tsx`), up to the cap of 12 lanes, which is 294 px; 8 lanes is 198 px. The dev repo at 1280 px shows 4 to 5 lanes, so its screenshots show the milder case. |
| 5 | Sidebar | Yes | "Viewing 82/82", stale / merged pills, dates and counts in different greys and sizes at different right edges, "Drag a branch here to pin it" for an empty Pinned section, a lone + and a filter icon in the footer. |
| 6 | Welcome | Yes | Logo and three cards centred in an empty window; no recents, no shortcuts. |
| 7 | Omni search | Yes | The same terminal icon on every suggestion and "Repository" as the subtitle of every command. |
| 8 | Two colour vocabularies | Yes | `bg-panel / text-muted / bg-accent` and `bg-background / text-muted-foreground / bg-primary`, with `accent` and `muted` meaning different things in each. Every shadcn component needed an override in the wrapper. |

## Findings beyond the list

- **Hint text fails contrast.** The "faint" grey is about 3.3 : 1 on the panel in both themes
  (dark `#707075` on `#1d1d20`, light `#8e8f94` on white); AA for 11 to 12 px text is 4.5 : 1. It
  is used for hints, counts, dates, placeholders and every "Sent with your next message". Now one
  utility (`text-muted-foreground/70`), so raising it is one change. UI audit 2.
- **Compact graph starves the message.** The branch/tag column takes 160 px and the lane strip
  200 px, the message column keeps about 90 px: "Publish si…". The header says "COMMIT ME…".
  Columns have fixed widths and the message gets what is left. UI audit 2.
- **Details header shows the full e-mail.** "Octo Cat <583231+octocat@users.noreply.gith…",
  truncated mid-address. Name and date are the content; the address is a tooltip. UI audit 2.
- **The diff header has five controls in three styles** in one 40 px bar: "This version ▾",
  "Diff tool", a Unified | Split segmented control, a Diff | History | Blame one, and ✕. Group
  them: view mode left, tools in a menu on the right. UI audit 2.
- **Status bar prints the repository path** in 11 px mono, right-aligned, truncated at its end
  ("/tmp/claude-0/-home-user-GitGoose/346cd904-0139-5110-b376-3e6a…"): the part that is cut off
  is the part that tells repositories apart. Truncate from the left, or show the folder only.
  UI audit 2.
- **The working copy splits its height 50 / 50** between Unstaged (3 files) and Staged (empty,
  one hint line), so a short list floats in a tall box. Split by content. UI audit 2.
- **Section headers are a fourth casing.** After the strips became sentence case, the remaining
  UPPERCASE 11 px headers ("UNSTAGED (3)", "1 FILE CHANGED", "BRANCH / TAG") are the odd ones
  out. Pick one: sentence case 12 px medium, muted. UI audit 2.
- **The commit box identity line** ("as Ada Lovelace <ada@example.com> · this repository") is
  11 px faint above the fields it describes. Fine as information, wrong as the first thing.
- **Empty sections draw chrome.** "Pinned 0", "STAGED (0)" with a paragraph. An empty section
  should be one muted line or nothing. UI audit 2.
- **Sizes were not a scale.** 274 hand-typed `text-[Npx]` in eight values (9, 10, 11, 11.5, 12,
  13, 14, 15) beside Tailwind's own 12 and 14; heights 24, 28, 32, 36 and 40 chosen per component.
  Done in UI audit 1.
- **`cn()` did not know our scale.** tailwind-merge reads an unknown `text-2xs` as a colour, so
  `cn('text-2xs', 'text-muted-foreground')` silently drops one. Found while doing the scale.
  Done (`lib/utils.ts`, with tests).

## Surface by surface

"Done" is UI audit 1; "Next" is UI audit 2.

| Surface | What is wrong (one line) | What to do (one line) | |
|---|---|---|---|
| Welcome | Logo and three equal cards float in an empty window, no recents, no shortcuts. | Recent repositories as the main list, Open / Clone / New as one row of quiet buttons, shortcuts as a footer. | Next |
| Graph, comfy | The lane cell grows with the lane count (198 px at 8 lanes, 294 at the cap of 12) so text starts mid-window; empty lanes sit on the left of most rows. | Cap it lower, compress unused lanes, let the message start at a fixed indent. | Next |
| Graph, compact | Ref column and lanes leave the message 90 px. | Message first: refs inline after it, lanes capped. | Next |
| Working copy | Staged and Unstaged split the height evenly; identity line is the first thing in the commit box. | Split by content; identity under the fields, in the commit options. | Next |
| Details | Explain row carried two selects and Prompt; e-mail address truncated mid-word. | One target button in the Explain row; name and date only. | Target button done; header Next |
| AI pane | Two headers; four stacked control bars (33% of the pane); empty state a faint paragraph top-left. | No pane header (New / History move to the strip); one composer box; centred empty state. | Done |
| Pane tab strips | Uppercase 11 px, ⋯ on every tab, an inset underline: a third tab style. | 12 px medium sentence case, 2 px primary underline, ⋯ on hover or when open, right-click opens the same menu, a right slot for pane actions. | Done |
| File diff | Five controls in three styles in one bar. | Group: view mode left, tools in a menu right. | Next |
| Omni search | One generic icon, "Repository" under every command. | An icon per kind (branch, commit, file, command), subtitle only when it says something (the shortcut, the file's folder). | Next |
| Context menu | Items are fine; shadcn's blue highlight was the old `accent`. Disabled items now carry reasons. | Done by the colour vocabulary: highlight is the subdued accent surface. | Done |
| Dialogs | Title, field and buttons are right but the width and spacing are chosen per dialog. | One width per kind, header / body / footer rhythm on the 4 px grid. | Next |
| Toolbar | Search is a fake input 26 rem wide; badges on pull and push overlap their icons. | Search as the shadcn `Input` with a kbd hint, badges as counts beside the icon. | Next |
| Sidebar | Eye row, mixed badges, always-on drag hint, lone + and filter icon. | One row anatomy, counts right-aligned in one column, hint only while dragging. | Next |
| Status bar | Path is truncated at the wrong end. | Truncate left or show the folder name. | Next |
| Tokens | Two vocabularies, hand-typed sizes. | One vocabulary, a documented scale. | Done |

## What changed in UI audit 1

### The scale (`styles.css`, top of the file)

| | Values |
|---|---|
| Type | `text-2xs` 11, `text-xs` 12, `text-sm` 13 (the body), `text-base` 15. Weights: normal, medium, semibold. |
| Space | 4 px grid (`p-1` = 4 px). |
| Radius | `rounded-sm` 4, `rounded-md` 6, `rounded-lg` 8. |
| Height | `h-row` 24, `h-row-lg` 28, `h-input` 28, `h-toolbar` 40, `h-tabbar` 36, `h-strip` 28, `h-statusbar` 24. |

A scripted pass moved every `text-[Npx]` to the nearest step: 9, 10, 11, 11.5 to `text-2xs`;
12 to `text-xs`; 13 to `text-sm`; 14 and 15 to `text-base`. The old Tailwind `text-sm` (14 px) is
now 13 px, which is the intent: the body size is one number. Line heights of `text-2xs` and
`text-sm` stay `normal`, so no row changed height.

### The colour vocabulary

shadcn's semantic names with shadcn's meanings, app-wide. 997 class names in 44 files were
rewritten in one pass (a single regex, so `hover` to `accent` is never rewritten again as `accent`
to `primary`; the generated `components/ui/*` files were not touched).

| Was | Now | Meaning |
|---|---|---|
| `bg-bg` | `bg-background` | the page; fields and code boxes sit on it |
| `bg-panel` | `bg-card` | a pane's surface |
| `bg-raised` | `bg-popover` | what floats: menus, popovers, dialogs |
| `bg-hover` | `bg-accent` | the hover and keyboard-highlight surface |
| `border-line` | `border-border` | every line |
| `text-fg` | `text-foreground` | text |
| `text-muted` | `text-muted-foreground` | secondary text |
| `text-faint` | `text-muted-foreground/70` | hints (the same grey, within 2 levels, in both themes) |
| `bg-accent`, `text-accent`, `border-accent` (the blue) | `bg-primary`, `text-primary`, `border-primary` | the one blue |
| `text-accent-fg` | `text-primary-foreground` | text on the blue |
| `bg-del`, `text-del` | `bg-destructive`, `text-destructive` | danger |
| `add`, `warn`, `select`, `ours`, `theirs`, `add-bg`, `del-bg`, lanes, heat | unchanged | app tokens: shadcn has no name for them |

`muted` (new, the subdued surface) and `secondary` exist for the generated components; the app
mostly says `card` and `accent`. A caution about the check "grep for `bg-accent`": `bg-accent` is
now legal and common (it is the hover surface), so the useful check is that no `bg-panel`,
`bg-raised`, `bg-hover`, `bg-bg`, `border-line`, `text-fg`, `text-faint`, `text-del` or the old
`text-muted` (without `-foreground`) is left.

### The AI pane, before and after

**Before** (dark, 1280 x 800, a commit selected): the right slot shows a strip "DETAILS ⋯ | AI ⋯"
and under it a second header, "AI · dev-repo", with + and a clock. Under it a paragraph in faint
12 px, top left. From the bottom up: a bordered textarea next to a blue Send button; a row with two
bordered selects ("Default (Claude…" cut off, "Default model") and a Prompt button; a block of
seven action buttons wrapping onto three lines, three of them dimmed; a row with the chip and a line of hint
text. 228 px of 700.

**After**: one strip, "Details | AI", with a 2 px blue underline under AI and two small icon
buttons (new conversation, history) at its right end. The body is empty space with a sparkle icon
and one centred muted line, "Ask about this repository, or drop commits, branches and files
here". At the bottom, one box with a 1 px border (blue while it has focus), 133 px of 700:
the chip at its top with a one-line hint after it, the text area, and a footer line: an
"Actions" menu button (lightning icon) at the left, "Claude · default" as a quiet ghost button
next to it, and at the right one icon button, Send, the only filled control. The seven actions
are a menu; the ones that cannot run stay in it, dimmed, with the reason on hover.

Why it is better, by the four questions. *Hierarchy*: the chip, the text and the Send button are
the message; everything else is quiet. There is exactly one filled control. *Grouping*: all of
the next message is inside one border, so the eye reads one object, not four bars. *Consistency*:
the target button is the same component in the Details header, the commit box, the review,
walkthrough and impact rails and the Recompose dialog (`AiTargetButton`). *Restraint*: the actions
and the model pick are things you do now and then; they cost 80 px and 130 px of a row instead of
a third of the pane.

### The tab strip

12 px medium sentence case instead of 11 px uppercase semibold; the active tab has a 2 px primary
bottom border (every tab has a transparent one, so choosing a tab moves nothing); a pane alone in
its slot shows its title in the same strip at the same height; the ⋯ is in the DOM but invisible
until the tab is hovered, focused or its menu is open; a right-click on a tab opens the same menu
(one menu, two ways in); and the strip has a right slot for the active pane's own actions, which
the AI pane uses for New and History. Details could put Review / Stash there later.

## Verification

Every change was checked by screenshot in dark and light: the graph with a commit selected, the
context menu (the highlight is the subdued surface, not blue), Details, the working copy, the file
diff, the AI pane (empty, with a chip, the actions menu open, the target popover open), a dialog.
