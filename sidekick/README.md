# sidekick

One Claude Code mod for working in one session across several repos:

- **The bar**: one line above the prompt (`✦ TL;DR · Heads up · ▶ 3 edits +12 −4`). Its buttons do work only when clicked, and the open item's panel shows under the line.
- **Scope guard**: keeps changes inside the session's target folder, so a `sed -i` run from the parent folder doesn't touch the sibling repos.
- **Long-lived rules**: suggested after the guard blocks something, approved by you, written into Claude Code's own settings.
- **TL;DR briefs**: a record of each session kept as it happens, and on click a brief of what happened (the last turn, since the last brief, or the whole session), with a claims check of Claude's final answer against the record, a handoff for picking the work up in a new session, and a HANDOFF.md per repo.
- **Heads-up**: on click, a review of the last answer for the one thing you'd likely miss.
- **Resume warning**: holds the first prompt of a resumed session whose prompt cache has likely expired.
- **Trim instead of summarizing**: past 80%, offers to drop stale tool output instead of summarizing (`/compact trim`), and does the same in place of Claude Code's own compaction when that frees enough.
- **Edit replay**: step through the last turn's file edits.

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

Rules are suggested rather than authored by hand. When the scope guard blocks something, **Rule? (n blocked)** appears on the bar; clicking it sends the blocked calls and the last answer to one Haiku call, which proposes a rule only if one is worth keeping: **add**, **not now** or **never** (never suggested again). Adding writes the settings file and confirms with Claude Code's own permission check that a fence is enforced, trying the other path spelling if not.

`/rules list`, `/rules add fence <folder>`, `/rules add exclusive <a> <b>`, `/rules remove <n>`. Rules stay until removed; each session start makes the settings file match them, and only entries sidekick wrote are ever touched.

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

## Settings

Set them with `/plugin configure sidekick@personal-mods`. Each is described there; the defaults are in `.claude-plugin/plugin.json`.

## Developing

`hooks/register.tsx` holds every hook and every function that touches `$`. The engine follows `$` only into functions declared at the top level of the hooks module, and a plugin has one hooks module, so this file can't be split further. Everything else is pure:
- `hooks/views/` draws the bar (`bar.tsx`, built by `bar-model.ts`), and the replay from the element table, plain data and callbacks;
- `scope-guard.ts`, `scope-rules.ts` (long-lived rules), `trim.ts`, `context-readout.ts`, `council-glimpse.ts` (what the bar reads of the council mod), `values.ts`, `long-answer.ts` (the heads-up review), `ledger.ts` (the session record), `brief.ts` (figures, the claims check, condensing, the handoff), `secrets.ts` (redaction), `resume-warning.ts`, `diff.ts`, `replay-steps.ts` and `settings.ts` hold the logic.

```bash
claude plugin validate ~/.claude/mod-sources/personal-mods/sidekick
```

```bash
claude plugin test ~/.claude/mod-sources/personal-mods/sidekick
```

The mod is read from this folder: after an edit, run `/reload-plugins`.

## License and attribution

Apache-2.0 (see `LICENSE`). The edit replay (`hooks/diff.ts`, `hooks/replay-steps.ts` and the replay parts of `hooks/register.tsx`) is adapted from Anthropic's `replay-theater` sample mod in [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater), Copyright 2026 Anthropic PBC. Each of those files notes what was changed. Everything else is original to this mod.
