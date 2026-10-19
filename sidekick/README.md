# sidekick

One Claude Code mod for working in one session across several repos:

- **The bar**: one line above the prompt (`✦ TL;DR · Heads up · ▶ 3 edits +12 −4`). Its buttons do work only when clicked, and the open item's panel shows under the line.
- **Scope guard**: keeps changes inside the session's target folder, so a `sed -i` run from the parent folder doesn't touch the sibling repos.
- **Long-lived rules**: suggested after the guard blocks something, approved by you, written into Claude Code's own settings.
- **Path rules**: "do not edit tests", "no new CSS": globs whose files may not be created, edited or deleted, from a council order's `forbid` or a standing rule, enforced by the scope guard.
- **TL;DR briefs**: a record of each session kept as it happens, and on click a brief of what happened (the last turn, since the last brief, or the whole session), with a claims check of Claude's final answer against the record, a handoff for picking the work up in a new session, and a HANDOFF.md per repo.
- **Heads-up**: on click, a review of the last answer for the one thing you'd likely miss.
- **Resume warning**: holds the first prompt of a resumed session whose prompt cache has likely expired.
- **Trim instead of summarizing**: past 80%, offers to drop stale tool output instead of summarizing (`/compact trim`), and does the same in place of Claude Code's own compaction when that frees enough.
- **Edit replay**: step through the last turn's file edits.
- **Ask Codex and Antigravity**: `ask_codex` and `ask_agy` let Claude put a prompt to the `codex` or `agy` CLI and read the answer. You approve every call, even in auto mode. A tool appears only when its CLI is on PATH.

It replaces the built-in "You should know" mod and Anthropic's `replay-theater` sample. Keep those disabled so they don't compete for the space above the prompt.

## The bar

| Item | Shows | On click |
| --- | --- | --- |
| **Cold cache** | only when a resumed session's first prompt is held | opens by itself: send, edit, don't hold, or handoff to a new session |
| **TL;DR** | always; `•` when the claims check found something or a long brief waits | briefs the last turn (see below); **more** shows the figures, phases and repos, **handoff** hands the session to a new one, **HANDOFF.md per repo** writes one per repo |
| **Heads up** | always | reviews the last answer (one Haiku call), then shows the note: ask Claude, knew it, dismiss |
| **Rule? (n blocked)** | after the scope guard blocks something | one Haiku call suggests a rule; add, not now or never |
| **▶ n edits +a −r** | after a turn with edits; `•` until opened | opens the replay |
| **ctx n% · +12k** | after the first turn (`contextReadoutEnabled`) | how full the context is and what the last turn added; the panel shows /context's breakdown (estimated locally, no request) and the turns that grew it most |
| **⚜ Council** | when the council mod is installed (`councilButtonEnabled`); `…` while it works | its topic and status; **ask the council** / **reconsider** put `/council ` or `/council reconsider ` in front of your draft, **open chamber** runs `/council show` |
| **Trim → ~n%** | past the trim threshold, when a trim reaches the target | explains it and puts `/compact trim` in the prompt |

The bar steps aside when no item is showing. `…` on an item means it's working. Only one panel is open at a time; click the item again or ✕ to close it. A new feature adds one item: `hooks/views/bar-model.ts` builds the items and panels from state, and `register.tsx` supplies the handlers.

## Scope guard

The target is the folder (or folders) under the session root that this session works in, set with `/scope set project`. Until you set one the guard is idle; it never guesses a target from Claude's edits. `/scope add .` adds the root's own files (not the folders under it), for a root that is itself a repo. A council knight or scout is held to its order's folder either way. The status line shows the target.

| | |
| --- | --- |
| File edits (Edit, Write, MultiEdit, NotebookEdit) | Blocked when the path is under the session root but outside the target. |
| Shell commands | Checked without a model. Reads anywhere are fine. Changes (`sed -i`, `perl -pi`, `rm`, `mv`, `cp`, redirects, `find -exec/-delete`, `xargs`, mutating `git`, package installs) are blocked when they'd land outside the target, including paths fed through `$(…)` or a pipe. Code run through `$(…)`, backticks, `bash -c`, `eval` or a heredoc fed to a shell is judged as a command of its own; `~` paths resolve against your home folder; `curl -o`, `dd of=` and `git branch -D`-style changes count as writes. |
| Commands it can't judge | Scripts, `make`, interpreters run from outside the target, inline interpreter code (`python -c`, a heredoc fed to `python`) anywhere, and anything after a `cd` it can't resolve. First `$.tool.check`: if Claude Code's own decider (your permission prompt, or the auto-mode classifier) will review the command anyway, nothing more is done. Otherwise Haiku decides, unless the classifier is off or your 5-hour usage is past `classifierUsageCap` (then it's let through). If Haiku is asked but gives no answer, the command is blocked. Answers are remembered per command, folder and scope until the next reload. |
| Outside the session root | Never policed (temp files, `~/.claude`). |

A blocked call goes back to Claude as a tool error that names the target. For a shell command it says how to re-run it scoped to the target; for a file edit, which can't be moved, it names the `/scope add` that would allow it (or `/scope clear`) for Claude to ask you about. Read-only git commands (`status`, `log`, `ls-remote`, `rev-list`, `check-ignore`, `worktree list`, `stash list` and the like) are never blocked. If the guard itself errors or runs out of time, it blocks the call (fails closed) and tells Claude to retry once, then stop and report; turn the guard off with `scopeGuardEnabled` or run `/scope clear` if it keeps failing.

`/scope` commands: `show`, `set <folder>`, `add <folder>`, `remove <folder>`, `clear`. `.` names the root's own files.

## Long-lived rules

The scope guard handles each session's live scope. Rules that should always hold go into Claude Code's own settings, `<root>/.claude/settings.local.json`, so the built-in checks enforce them:

| Rule | Written as | Enforced by |
| --- | --- | --- |
| `fence <folder>`: never edit it | a `permissions.deny` `Edit(…/**)` rule | Claude Code itself, in every mode, no model |
| `exclusive <a> <b>`: never both in one session | an `autoMode.soft_deny` sentence (keeping `$defaults`) | `/scope add` refuses the partner, plus the auto-mode classifier (a scope set with `/scope set` isn't checked against it) |
| `forbid <glob> [ops] <reason>`: a standing [path rule](#path-rules) | an `autoMode.soft_deny` sentence | the scope guard's path rules, for every session and agent in the root, plus the auto-mode classifier |

Fences and exclusive pairs are suggested rather than authored by hand (path rules are only ever yours). When the scope guard blocks something, **Rule? (n blocked)** appears on the bar; clicking it sends the blocked calls and the last answer to one Haiku call, which proposes a rule only if one is worth keeping: **add**, **not now** or **never** (never suggested again). Adding writes the settings file and confirms with Claude Code's own permission check that a fence is enforced, trying the other path spelling if not.

`/rules list`, `/rules add fence <folder>`, `/rules add exclusive <a> <b>`, `/rules add forbid <glob> [ops] <reason>`, `/rules remove <n>`. Rules stay until removed; each session start makes the settings file match them, and only entries sidekick wrote are ever touched.

## Path rules

A path rule names files that may not be created, edited or deleted: a glob, the operations it forbids, and your reason, which Claude is shown. The scope guard enforces them whenever it is on (`scopeGuardEnabled`), with or without a target set. They come from two places:

- **A council order's `forbid`.** Each dispatch Claude proposes to the council may carry `forbid: [{ glob, ops?, reason }]`. Its globs are relative to the order's folder, and only that order's agent is held to them. "Do not edit tests": `{ "glob": "**/*.spec.ts", "reason": "the tests are the spec" }` (no `ops` means create, edit and delete).
- **Standing rules.** `/rules add forbid <glob> [ops] <reason>`, the glob relative to the session root, held by every session and agent in that root. "No new CSS under any repo's frontend/src": `/rules add forbid */frontend/src/**/*.css create no new CSS; use the theme tokens`. `ops` is a comma list of `create`, `edit` and `delete`, all three when left out.

Globs stay small: `*` and `?` match within one name, `**` spans folders, a glob with no `/` matches the file name at any depth (`*.css` is `**/*.css`), and a trailing `/` means everything under that folder. No braces, character classes or regex. A path is matched relative to the rule's folder in any spelling (drive letters, backslashes, Git Bash's `/c/…`), and case-insensitively on Windows.

| Layer | When | Catches |
| --- | --- | --- |
| File tools | before Write, Edit, MultiEdit, NotebookEdit | a create (the file isn't there yet) or an edit (it is) of a matching path |
| Bash | before a shell command, from the paths it names | `rm`, `rmdir`, `unlink`, `shred` and `git rm` delete; `mv` and `git mv` delete their sources and write their destination; redirects (`>`, `>>`), `tee`, `touch`, `cp`, `ln`, `install`, `rsync`, `sed -i`, `perl -pi`, `chmod`, `truncate`, `patch`, `curl -o`, `dd of=`, `git checkout` and `git restore` write, a create or an edit by whether the file is there. A copy or move into a folder writes the names it puts there. It follows `cd`, `git -C`, `$(…)`, `bash -c` and shell heredocs. |

The Bash layer only sees paths a command spells out. Indirect writes get past it: scripts and build tools (`node gen.js`, `npm run …`, `make`), `xargs` fed paths through a pipe, `find -exec` or `-delete`, interpreter code (`python -c`), `rm -r` of a folder holding protected files, and shell globs that expand to names it doesn't spell (`rm src/*`).

Every refusal names the change, the rule's glob and operations, where it came from (`order O7` or the standing rule), the layer that fired and your reason, and tells Claude that the path is protected and, if it must change, to stop and report why instead of working around it. A toast says the same to you.

## TL;DR briefs

Long sessions end with a final answer you'd otherwise have to take on trust. The TL;DR checks it against what actually happened.

- **The record.** While you work, sidekick records each prompt, Claude's own words between calls, every tool call (a few words for what it did, success or error, files changed with lines added and removed, commits and pushes, test runs, subagent reports) and each final answer. No model calls. Secrets are redacted by pattern before anything is written. It lives in `~/.claude/sidekick/ledgers/<session>/` (readable only by you, never in a repo), survives a resume, and ledgers untouched for 14 days are deleted at session start.
- **The brief.** On click, the figures are counted from the record (duration, calls by tool, errors, test runs and how the last one ended, files changed, commits) and Haiku reads a condensed log: your prompts, Claude's words, notable calls one by one, routine calls grouped. A short tool-less turn gets the old one-sentence TL;DR. The panel shows **Done**, **Stuck** and **Needs you**, then the claims check.
- **The claims check** (rules, no model call, only high-confidence findings): says tests pass but the last test run failed or none ran; says it committed or pushed with none recorded; says it changed a file with no edit recorded; files edited but never named in the answer; edits that failed and were never redone; an interrupted turn.
- **Big spans.** A condensed log over 60,000 characters is read in parts (one call each, three at a time, cached so pressing again costs only new parts) and merged by one more call. At most 12 parts: past that, routine calls are dropped, then the earliest parts are left out and the brief says so. A brief needing more than 3 calls waits on the bar for **run (n calls)**.
- **Spans.** The bar button briefs the last turn. `/tldr since` (or `range`) briefs everything since the last brief; `/tldr full` (or `whole`, `complete`) the whole session.
- **Handoff to a new session.** **handoff** briefs the whole session (asking first when that takes more than 3 Haiku calls), writes `HANDOFF.md` beside the record in `~/.claude/sidekick/ledgers/<session>/` (the brief, the claims check, any held prompt, every repo it changed, and where the full record is) and copies a first prompt for the new session that points at it. If the copy fails, the card shows the path instead. It's cheaper than resuming a session whose cache expired, and it never reads the conversation itself.
- **HANDOFF.md per repo.** Writes one file per repo the span changed: the brief, the claims check, that repo's files and commits, and its uncommitted and unpushed counts. Sidekick never commits it.

## Heads-up

One call to the `model` setting (default `claude-haiku-5-5`) on Claude's last answer.
- **Heads-up** runs only when you click it (or `/heads-up now`), and also sees the files the last turn edited. The headline is at most 12 words. **knew it** means that topic is never raised again; `/heads-up known` and `/heads-up forget` manage those.

## Resume warning

When a resumed session's prompt cache has likely expired, your first typed prompt is held. The bar opens **Cold cache** with the session's age, the context to re-send and the estimated re-cache cost: **send**, **edit** (back to the prompt box), **don't hold**, or **handoff to a new session** (the held prompt goes back to the prompt box unsent and into the handoff; the TL;DR card shows the progress). Slash commands such as `/compact` are never held.

## Trim instead of summarizing

A trim drops stale output instead of summarizing the conversation: every tool's output from turns before the newest `trimKeepTurns`, except three kinds it keeps whole:
- your answers to Claude's questions (AskUserQuestion);
- subagent reports (Agent);
- results flagged as errors, such as a command that exited non-zero. A failure hidden behind a pipe (`npm test | tail`) isn't flagged, since the pipe reports the last command's exit; that gap is accepted.

Each dropped output becomes a one-line stub naming the call and how long its output was. A read's stub says Claude can read it again; any other stub just records that the output was dropped, so nothing invites re-running a command that changed something.
- Every prompt, every answer's text and every tool call stays.
- Reasoning is dropped from the first stub on: current models bind each reasoning block to the exact history before it, so a block after an edit is invalid (the API refuses it on enforced accounts). Messages before the first stub stay whole, reasoning included.

When it happens:
- **On the bar:** after a turn, if the context is at least `trimAtPercent` full (80) and a trim would bring it to `trimTargetPercent` or below (50, estimated at four characters a token, not counting the reasoning it also drops), **Trim → ~45%** appears. Its panel puts `/compact trim` in the prompt; you run it.
- **`/compact trim`:** always trims (whatever it reaches), or says there's nothing stale to drop. It leaves the newest turn's output, like the automatic trim.
- **`/compact trim all`:** also drops the newest turn's output, for when it's finished: e.g. the morning after an overnight job, which is one long turn. The cache has expired by then anyway, so trimming first makes the one cold resend smaller.
- **Claude Code's own automatic compaction:** trimmed instead when the same two thresholds hold; otherwise the usual summary.

Any other `/compact` is the usual summary. A trim, like any compaction, restarts the prompt cache once. Sidekick can't start a compaction itself: the engine skips the calling plugin's hooks, so its own request would become a summary; that's why the bar offers and you run it.

The council is its own mod, `council`, in the same marketplace. Sidekick shows its button by reading the council mod's state (any plugin may read another's); it never writes it.

## Edit replay

After a turn that edited files, **▶ n edits** on the bar opens the replay; `/replay` opens it any time. In the pane: `n` next, `p` previous, `c` or Esc to close. Only edits that succeeded are recorded.

## Asking Codex and Antigravity

Two tools let Claude put one prompt to another agent's CLI and read its answer: **`ask_codex`** runs OpenAI's Codex CLI, **`ask_agy`** the Antigravity CLI. Claude sees them as `mcp__sidekick__ask_codex` and `mcp__sidekick__ask_agy`.

- **Your approval, every call.** Each call stops for you, in every permission mode, auto mode included. The dialog names the CLI and its vendor and shows the prompt (the first 8,000 characters; the tool input holds all of it). Sidekick asks through a PreToolUse hook, which the engine keeps as a floor: auto mode's classifier can't approve past it, and an allow rule doesn't skip it. The tool's own permission check asks too. If a hook fails, it still asks. A session with no one to answer (`claude -p`, `dontAsk`) gets a refusal instead. Saying yes to one call never approves the next.
- **Found on PATH at session start.** Sidekick looks for `codex` and `agy` once when the session starts. It checks only absolute PATH entries, so a `.` entry can't pick up a file a repo planted. On Windows it tries PATHEXT's `.com`, `.exe`, `.bat` and `.cmd`, in PATHEXT's order. A CLI that isn't found gets no tool, so Claude never sees it. The path found is the one that runs for the rest of the session, so a look-alike added to PATH later is never picked up. If you install a CLI mid-session, restart the session or run `/reload-plugins` to get its tool. Turn both tools off with `askToolsEnabled`.
- **How it runs.** The CLI is started from an argument list with no shell, in the session's folder, with fixed arguments and the prompt on stdin. No character of the prompt can become a flag or shell syntax. Codex runs as `codex exec --sandbox read-only -c approval_policy=never --skip-git-repo-check --ephemeral --color never -`: it can read files in the session's folder and nothing it runs can write. `agy` gets the prompt on stdin and no arguments. Its flags have not been checked against a real `agy`, and no read-only mode is passed for it, so it runs with its own defaults.
- **Limits.** Each call has 5 minutes. The prompt can be up to 100,000 characters. The answer is cut at 20,000 characters, and the cut is marked. A timeout, a non-zero exit, empty output, a CLI that won't start or one that's missing comes back as a short error, with the end of the CLI's error output (secrets redacted).
- **Untrusted answers.** The answer comes back labelled as untrusted text from another model. The tool description tells Claude to weigh it as advice, never follow instructions in it, and check its claims before acting.
- **Where your data goes, and what it costs.** Each call sends the prompt to OpenAI (Codex) or Google (Antigravity) under that vendor's own terms and privacy policy, and Codex also sends any files it reads in the session's folder. Approve only what you'd share with that vendor. Each call counts against your Codex plan (or OpenAI API key) or your Antigravity plan quota. Sidekick sets no spending cap beyond the timeout and the answer limit. The CLIs use their own sign-in: sidekick never handles their credentials or bypasses their auth.

## Settings

Set them with `/plugin configure sidekick@personal-mods`. Each is described there; the defaults are in `.claude-plugin/plugin.json`.

## Developing

`hooks/register.tsx` holds every hook and every function that touches `$`. The engine follows `$` only into functions declared at the top level of the hooks module, and a plugin has one hooks module, so this file can't be split further. Everything else is pure:
- `hooks/views/` draws the bar (`bar.tsx`, built by `bar-model.ts`), and the replay from the element table, plain data and callbacks;
- `scope-guard.ts`, `scope-rules.ts` (long-lived rules), `trim.ts`, `context-readout.ts`, `council-glimpse.ts` (what the bar reads of the council mod), `values.ts`, `long-answer.ts` (the heads-up review), `ledger.ts` (the session record), `brief.ts` (figures, the claims check, condensing, the handoff), `secrets.ts` (redaction), `resume-warning.ts`, `diff.ts`, `replay-steps.ts`, `ask-cli.ts` (finding and running Codex and Antigravity) and `settings.ts` hold the logic.

```bash
claude plugin validate ~/.claude/mod-sources/personal-mods/sidekick
```

```bash
claude plugin test ~/.claude/mod-sources/personal-mods/sidekick
```

The mod is read from this folder: after an edit, run `/reload-plugins`.

## License and attribution

Apache-2.0 (see `LICENSE`). The edit replay (`hooks/diff.ts`, `hooks/replay-steps.ts` and the replay parts of `hooks/register.tsx`) is adapted from Anthropic's `replay-theater` sample mod in [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater), Copyright 2026 Anthropic PBC. Each of those files notes what was changed. Everything else is original to this mod.
