# inline-slash

Use `/template` and `/skill:name` anywhere in a sentence.

Pi core handles both only when the whole message starts with `/`, and its
completion menu only opens at the start of the first line. This extension closes
both gaps.

```
用 /p-fact-check 看这段        →   用 核对事实，标注不确定处。 看这段
用 /skill:code-review 看这段   →   <skill name="code-review" …>…</skill>  前置注入
```

## What each kind does

| Token | Effect |
|---|---|
| `/template` (prompt prompt) | body substituted **in place**, the token disappears |
| `/skill:name` | body injected **in front** of the message, the token stays in the sentence |
| `/model`, `/compact`, … | not supported — see below |
| extension commands | not supported — see below |

Skills are injected the way pi injects them itself (`<skill name location>` block
plus `References are relative to …`), copied from core's `_expandSkillCommand`.
A skill named twice in one message is injected once.

## Why not every slash command

- **Built-in commands** (`/model`, `/compact`, `/new`) and **extension commands**
  are dispatched by pi before this extension's `input` hook runs. A token written
  mid-sentence reaches the model as plain text and nothing else can be done with
  it, so the menu does not offer them.
- **Skills** are possible because they are text that gets attached to the turn —
  but they are attached *in front*, not at the position where you wrote the
  token. Inserting a multi-paragraph instruction block mid-sentence reads wrong
  and is easy to miss.

## Completion

Start typing `/` plus the first letter after a space (or CJK punctuation) and the
menu opens where you are typing — mid-sentence and on later lines included.
Templates and skills are matched by plain case-insensitive substring, so a bare
`/code` finds `/skill:code-review`. Exact name first, then leftmost match, then
shortest name. `Tab` takes the highlighted entry, `Esc` closes the menu.

Two things stay out of the way:

- at the very start of the first line the built-in menu wins, so commands, skills
  and file paths still complete there;
- a path such as `看 /usr/local` opens nothing, because no name matches.

## What is left alone

Fenced code blocks, inline code spans, unknown tokens, and path-like strings
(`/home/me/file.ts`). Input that starts with `/` is passed straight through, so
core keeps handling its argument parsing exactly as before.

## The private bit

Pi's editor only opens its own menu at the start of the first line, so the
keystroke trap is installed by wrapping the editor (`getEditorComponent` /
`setEditorComponent`). That wrapper reads the editor's cursor state and calls its
`tryTriggerAutocomplete`; if a pi upgrade renames either, the menu stops
auto-opening and `Tab` remains. The smoke check catches that.

## Test

```sh
npm run test:inline-slash   # pure logic + real-editor smoke check
```
