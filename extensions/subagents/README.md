# pi-subagents

The active subagent extension for this repository.

- `index.ts` — registers visible-first `subagent`, compatibility `subagent_visible`, and visible lifecycle tools. Visible startup failures automatically fall back to synchronous execution with a reported reason.
- `agents/` — bundled agent definitions; project and global definitions may override them.
- `tools/` — private helpers loaded by child Pi processes.
- `test/` — focused Node smoke tests.
- `config.json` — local concurrency and model overrides.

Run its tests from the repository root:

```bash
npm run test:subagents
```

Pass `visible: false` to `subagent` for an explicitly synchronous hidden call that never attempts visible pane creation. Visible children show their available and denied tools above the editor. Press
`Ctrl+Shift+J` to expand or collapse that widget. Press `Ctrl+Shift+S` to stop
starting new work, summarize the information already obtained, return that
report to the parent, and close cleanly. `Escape` remains an immediate abort
that leaves the child pane open. `caller_ping` returns a help request plus a
resumable session path to the parent, and `subagent_done` closes the child
explicitly. Reply with `subagent_resume` and that session path.
