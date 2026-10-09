# prompt-history

Ctrl+R reverse search over your prompt history, as a **floating panel** above the
prompt box.

```
╭─ History Search ─────────────────────────────────────────╮
│ > ret▌                                             [1/1] │
├──────────────────────────────────────────────────────────┤
│ ▸ Add retry backoff and jitter to the worker             │
├──────────────────────────────────────────────────────────┤
│ C-n/C-p move · Enter/C-j select · C-r repeat             │
│ C-a/C-e line ends · C-k kill · Esc/C-g cancel            │
╰──────────────────────────────────────────────────────────╯
```

| Key | Action |
| --- | --- |
| `Ctrl+R` | Open the panel; press again (or `↓`) to walk to older matches |
| _type_ | Filter: every word you type must appear in the prompt, in order |
| `↓` / `Ctrl+N` | Older match (down the list) |
| `↑` / `Ctrl+P` | Newer match |
| `Enter` / `Ctrl+J` | Put the match into the editor (not sent) |
| `Ctrl+A` / `Ctrl+E` | Query cursor to line start / end |
| `←` `→` `Home` `End` | Move the query cursor |
| `Ctrl+K` | Kill the query from the cursor to the end |
| `Backspace` / `Ctrl+H` | Delete the character before the cursor |
| `Esc` / `Ctrl+C` / `Ctrl+G` | Close, draft untouched |

The panel opens with the editor's current text as the query, so `Ctrl+R` on a
half-typed prompt picks up where you left off; clear it with backspace to see the
whole pool.

## Layout

The panel is a real overlay: `ctx.ui.custom(factory, { overlay: true, overlayOptions })`
with `anchor: "bottom-center"`, `width: "100%"`, `maxHeight: "80%"`. It floats over
pi's content, so the prompt box keeps its text and its height, and the panel is
free to be taller than the prompt box.

Height is content-driven — `OverlayOptions` has no `height`, only `maxHeight` — so
the list hugs the results (capped by `MAX_LIST_LINES` and by the terminal height).

## Where the history comes from

`history.ts` reads the session files pi already writes: the live session branch
plus earlier sessions in the same directory (`SessionManager.list(cwd)`).

Nothing is cached, indexed or copied — there is no second plain-text copy of your
prompts on disk.

The directory scan runs once at session start, in the background: on a large
history it costs a few hundred ms, which must not land on pi's startup path. The
panel can therefore open with the live session alone for its first keystrokes and
fill in as the scan lands.

## Files

| File | Role |
| --- | --- |
| `index.ts` | pi entry: `SearchOverlay` (the panel) + the editor wrapper that catches Ctrl+R |
| `history.ts` | session sources (live branch + same-directory sessions) |
| `prompts.ts` | session entries → prompts (pure) |
| `search.ts` | fuzzy matching + panel rendering (pure) |
| `test/search.test.ts` | matching and panel rows, plain `node --test` |
| `test/editor-smoke.mjs` | fake pi host: opens the overlay, drives it, checks what lands in the editor |
| | both run via `npm run test:prompt-history` from the repo root |

## Notes

- Ctrl+R is the default hotkey; `~/.pi/agent/prompt-history.json` moves it, e.g.
  `{"keybind": "f8"}`. Extension raw input runs before the focused editor, so an
  extension listening for the same key wins silently — dictation claims Ctrl+R by
  default, and on a default setup this panel would never open. Move one of the two.
- pi's own Ctrl+R action ("rename session") only exists inside the session picker,
  so the editor-level binding does not fight it.
- Ctrl+R is caught by the editor wrapper, not `pi.registerShortcut`.
- The wrapper composes with any other editor wrapper (dictation's, for example)
  by Proxy-forwarding members it does not implement.
