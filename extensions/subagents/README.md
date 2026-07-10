# pi-subagents

The active subagent extension for this repository.

- `index.ts` — registers synchronous `subagent` and visible-pane tools.
- `agents/` — bundled agent definitions; project and global definitions may override them.
- `tools/` — private helpers loaded by child Pi processes.
- `test/` — focused Node smoke tests.
- `config.json` — local concurrency and model overrides.

Run its tests from the repository root:

```bash
npm run test:subagents
```

Visible children show their available and denied tools above the editor. Press
`Ctrl+J` to expand or collapse that widget; `caller_ping` returns a help
request plus a resumable session path to the parent, and `subagent_done` closes
the child explicitly. Reply with `subagent_resume` and that session path.
