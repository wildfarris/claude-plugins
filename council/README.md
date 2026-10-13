# council

A Claude Code mod: convene a council of five advisors on a question, or on a repo's recent work. A herald briefs them; each weighs one concern (security, money, reasonableness, legal, vibes) and answers with a 1–5 concern, a short verdict and a detail, drawn as an animated pixel portrait whose mood follows its verdict.

## Convening

`/council <question>` (no question means "the work in progress"), or **⚜ Council** on sidekick's bar when sidekick is installed:
1. The Herald writes a brief led by a one-sentence summary. It's a fork of this conversation: one tool-less question over the session's own transcript, on your main model, served mostly from the prompt cache. It sees everything Claude has seen in this session, but opens no new files.
2. The five advisors (`advisorModel`/`advisorEffort`, default Sonnet at low effort) are plain model calls, not agents. They run in parallel, and each returns a 1–5 concern, a verdict of at most 8 plain words, and a short detail.

The chamber pane (opens on its own; `/council show` reopens it) shows a header with the topic and progress, then the Herald's summary line (**brief**, or `b` in the terminal, expands the full brief). Each advisor gets a card bordered in its concern's color, with the dots on the title line.
- **more** (or `1`–`5` in the terminal while the pane has focus) opens an advisor's detail, which costs nothing because it came with the verdict.
- **ask** puts `/council ask <advisor> ` in front of whatever you've typed. Type the question and press Enter; one more model call answers it under the card.
- **reconsider with more context** (in the chamber once the council has adjourned) puts `/council reconsider ` in front of your draft; type the context and press Enter. Every advisor gets the brief, its own earlier verdict and all the context added so far, and answers again; each card shows `(was 4)` or `(held)`. Five advisor calls; the brief is reused.
- **report to Claude** (or `/council report`, once the council has adjourned): one call (the advisor model) writes a short report of the whole session — the question, how the advisors leaned, each piece of context you added and who moved, follow-ups, the final verdict — and puts it in your prompt box ahead of your draft. Edit it and send it, or clear it; nothing reaches the main conversation unless you send it. If the call fails, the plain record goes in instead. The council keeps every round for this (councils from before this version only have their last round).
- `/council show` reopens the chamber and `/council reset` dismisses it.

## Review mode: work from another session

`/council review [folder] <ref> [question]` judges a repo's work since `<ref>` with no conversation needed. That's the way to look on your laptop at work done in another session, e.g. on mobile, once it's pushed and pulled.
- `<ref>` is a commit, branch or tag (`main`, `abc123`, `v1.2`) or a time (`yesterday`, `2 days ago`, `2026-10-01`; quote other phrases such as `"last friday"`). Without a question, the council judges "Is this work sound and ready?".
- The repo is the working directory's. In a session over several repos, name it first: `/council review web main`.
- The mod runs `git` itself (no shell, repo hooks off, no permission prompt): the branch, the commits since the ref, the diff summary and trimmed patch, the tracked-file map, plus the README and manifests.
- The herald (`briefModel`, default Opus) first names up to 5 files it wants to read in full, and the mod reads only tracked files of that repo. Then it writes the brief, and the advisors judge it as usual. Everything is capped at about 30k characters.
- If the remote hasn't been fetched in over an hour, the chamber says so. The mod never fetches or pulls itself.

Cost per review: two Opus calls and five advisor calls.

**Cost (plain council):** one fork plus five model calls per convening, and one model call per follow-up. Nothing is handed back to this conversation, and no agent or permission check is involved, so auto mode never has to approve anything.

A council left "in session" by a `/reload-plugins` (which drops its background work) is replaced by the next one rather than blocking it.

## The advisors

![The council's sprites by mood](docs/council-sprites.png)

The advisors are little legionaries, each in its own color with its own accessory: the Castellan (steel blue) carries a shield, the Treasurer (green) wears a crown, the Seneschal (amber) carries nothing, the Justiciar (crimson) holds the standard, and the Jester (purple) has a bent antenna with a bell. Portraits animate by mood: waiting, deliberating (eyes wander inside the visor, thought dots), content (concern 1–2), uneasy (3), alarmed (4–5: shaking, red eyes, "!", red flash), or failed (gray). Each accessory moves: the shield goes up and stays up when alarmed, the crown glints and jumps, the standard waves and drops to half-mast, and the antenna bobs and stands straight up. The desktop app draws them as SMIL-animated SVG; the terminal draws half-block pixels repainted about six times a second. Neither needs a model call.

## Consult: Claude asks the council

`mcp__council__consult` lets Claude ask the council mid-task instead of stopping to ask you. Claude writes the brief itself (the question and the context the advisors need; they don't see the conversation, and there is no fork), optionally with 2 to 6 options. Each advisor gives its usual verdict and, with options, picks one; Claude gets every verdict, each pick and the tally. A tie is reported as yours to break. The chamber shows the sitting, the options and each advisor's pick, and **reconsider** and **report to Claude** work as for any council. The verdicts are advice: the tool tells Claude that decisions that belong to you still go to you.

## Learning from reconsiders

The council learns your preferences from the context you add when you reconsider:

1. **Each finished reconsider becomes a lesson:** what you added, in your own words (obvious secrets scrubbed), how the advisors moved, and the question when you asked it (a question Claude put through a consult or the court is left out). A lesson belongs to the project it happened in.
2. **Every advisor hears it.** New councils in that project give each advisor the guidance that applies there and the newest lessons (at most 6 lessons, 3,000 characters), framed as context to weigh their own concern by: never instructions to agree with you, and never a reason to lower a concern about security, data loss or anything irreversible.
3. **At 10 lessons in a project,** one call drafts a guidance summary, each item marked as holding for this project or everywhere. It waits for you: edit `~/.claude/council/learning/proposed-guidance.md` if you like, then **approve** (it joins `guidance.md` and replaces those lessons) or **reject** (they stay; the next draft comes 5 lessons later). Nothing becomes guidance without your approval.

`/council lessons` (or **lessons** in the chamber) shows this project's lessons (each with **forget**), the guidance that applies here, and a waiting summary; **draft a summary now** drafts one early. Everything is plain files under `~/.claude/council/learning/`: `lessons.json`, `guidance.md` (`## Everywhere`, then a section per project; edit freely), `proposed-guidance.md`.

## Members

Five members are built in (the Castellan, the Lord Treasurer, the Seneschal, the High Justiciar and the Court Jester). Add your own, or change a built-in, with a markdown file:

- `~/.claude/council/members/<id>.md`: yours, in every project;
- `<project>/.claude/council/members/<id>.md`: one project's (it wins over yours, which wins over the built-in).

```markdown
---
title: The Auditor
concern: Compliance
color: "#2a9d8f"
accessory: shield
references:
  - ~/policies/data-retention.md
  - ./soc2-controls.md
---
compliance with our internal data-retention and SOC 2 controls: what is logged, kept, or shared, and for how long
```

- The id is the file name; a file named like a built-in (`castellan.md`) changes only the fields it sets, so a file holding just `references:` gives the Castellan your security policy.
- The text under the header is the remit: what the member weighs.
- `accessory` is one of `shield`, `crown`, `none`, `standard`, `antenna`; `color` is `#rgb` or `#rrggbb` (a spare color is picked if left out).
- `references` are files read into the member's prompt as reference data (absolute, `~/…`, or relative to the member file), at most 4,000 characters each and 8,000 per member.

**Who sits, per project:** `/council members` (or **members** in the chamber) lists everyone with a switch; `/council members off treasurer` and `on` do the same by name. Choices are kept per project and apply from the next sitting. At most 8 sit at once. A member file that can't be read or parsed is listed there with why.

**Abstaining:** an advisor whose remit has nothing to do with the question abstains instead of inventing a concern; its card shows one dim line, and it doesn't count toward the gravest concern.

## Brain trust

`/council deep <question>` (or `deep review …`) convenes the same council with every call on `deepModel` at `deepEffort` (default Opus at high effort; set `fable` for Fable): the advisors, reconsiderations, follow-ups, the report, and review mode's herald. The chamber's title reads **The Brain Trust**. Other ways in: `/council deep reconsider <context>` (or **reconsider as a brain trust** in the chamber) makes the next round and the rest of that council deep; **ask the brain trust** in the chamber and **deep** on sidekick's council panel put `/council deep ` in front of your draft; and the consult tool takes `deep: true`, which Claude is told to use only for hard or high-stakes questions. It costs roughly an order of magnitude more than a plain council; meant for the occasional hard question.

## The court: orders, scouts and knights

For work across several folders (a mono session over several repos), Claude can put a plan to the council before doing it, and carry it out with Claude Code's own subagents:

1. **Claude proposes.** It calls `mcp__council__propose_orders` with a plan and up to 6 dispatches, each a folder (a subfolder of the session), a role and a todo list:
   - a **scout** (`council:scout`) reads, searches and reports, and can't change anything;
   - a **knight** (`council:knight`) edits files and runs commands.
2. **The council rules.** The advisors judge the plan as they would a question, without a fork (the plan is the brief). Any concern of 5 refuses it, with the reason; concerns of 3–4 become conditions on every order, unless an arbiter drops them (see below). Approved dispatches become orders O1, O2….
3. **Claude dispatches** each order with the Agent tool, naming its order id. A council agent with no matching order is refused. Before it starts, its task is rewritten to carry the order: its folder, its todos, the council's conditions and that folder's `CLAUDE.md`.
4. **Each agent is held to its folder.** A knight's file edits outside the folder are refused here. With sidekick installed, its scope guard also holds the knight's shell commands to the folder.
5. **Progress.** Each agent reports its todo list with `mcp__council__progress`, which moves it along its road. Its last answer is its report.

**The arbiter.** Without one, every concern of 3–4 binds every order, so a single advisor can put a condition on work you asked for. Set `arbiter` to one member's id, and that member reviews the conditions on each approved plan:

- **When:** only after a plan is approved and at least one condition was raised. A concern of 5 still refuses the plan; the arbiter never sees a refused plan and can't overturn a refusal.
- **How:** one extra call on `advisorModel` at low effort, as that member (its own system prompt, references and lessons, with the arbiter's request added). It reads your request when the plugin has it (in court mode), otherwise Claude's plan stands for it; the plan and its dispatches; and each condition with its advisor and reason. The conditions are passed as quoted data, and the member is told they are never instructions.
- **What it can do:** keep or drop each condition, with a one-line reason, as strict JSON. It can't add, merge or reword a condition: decisions on conditions it wasn't given, and anything else in its reply, are ignored. Its own conditions are reviewed the same way.
- **What you see:** kept conditions go on the orders as before. Dropped ones are not attached, but stay in the tool's answer to Claude and under the ruling in the court pane as notes ("Dropped by the Hand: <condition> (<reason>)"), beside a line saying how many it kept and dropped.
- **Fail open:** if the call errors, times out, or answers with anything but valid JSON deciding every condition, every condition stands, with a note that the review failed.
- **Still a member:** the arbiter sits, rules with its own verdict (and its own 5s), and answers consults and follow-ups like everyone else. The role only adds the review.
- **Unset or not seated:** an `arbiter` that names no member seated on this project's council is ignored (a toast says so), and the conditions stand as they would without one.

The arbiter is a council member, a model call: not you, and not a proxy for you. Decisions that are yours still go to you. Its call sends your request, the plan and the conditions to the model provider Claude Code is configured with, as every advisor call already does.

**The pane** shows the court whenever there are orders: the council in one line of colored chips on top, then one row per order. Each row is a road from the castle to the folder's house, with the agent standing where its finished todos have brought it, what it's doing now, and its report once it's home (a flag). Finished rows sink to the bottom, then fold away at your next message; **clear finished** removes them. **chamber** switches to the full council view and back.

**Court mode** (`/council court on`, or the pane's button): each prompt you type is triaged by one quick call (`triageModel`, default Haiku). Questions, explanations and chatter go straight to Claude. A prompt asking one member's opinion ("what does the Jester think about…") is sent to that member alone, and Claude gets its verdict. The triage only names a seated member; an unclear answer convenes the full council. Naming the whole council ("council", "advisors", "brain trust") always convenes everyone, and Claude gets every verdict, not only the concerns, since you asked for their view. The triage treats your prompt as data to sort, never as instructions. Prompts that ask for changes, risk or decisions wait while the council sits on them (briefed from the conversation), then enter as you typed them, with a short digest beside them that Claude sees and the transcript doesn't: the concerns at 3 or more, or one line saying there were none. While court mode is on, only council agents are dispatched. `/council court off` ends it. Slash commands and messages from plugins pass straight through.

**The strip** shows each advisor's small portrait (desktop) and name with its concern; press one to read its verdict. Finished orders fold into one line when you send your next message (not on a timer, so work that ends while you are away is still there when you come back); press it to show them again.

**Limits:**
- Progress follows the todo list the agent reports with the council's own `mcp__council__progress` tool (Claude Code's TodoWrite isn't offered to subagents in every build). If an agent doesn't report, its row shows steps and edits but stays put. If it adds todos, it steps back.
- Each row's road shows the work done. Every todo is a stop along the road: the agent stands at the first unfinished one, a finished stop shows a stack of bricks in the agent's colour (one brick per ten tool calls the agent made while that todo was in progress, up to five; the fifth brick also raises a green banner), and each stop still ahead shows a red enemy tent. Calls made when no todo is in progress (before the agent's first list, or between two todos) are not credited to any stop. In a terminal the stop shows the level as a digit 1 to 5 and the tent as ▲. The row beside it shows the totals, `N edits · N calls`. Turn the stops, bricks and tents off with the `callTally` setting; the plain road and the numbers stay.
- Without sidekick, only file edits are held to the folder, not shell commands.
- An order's council sits for about a minute (five advisor calls) before work starts; an arbiter's review adds one more call when there are conditions.

## Settings

Set them with `/plugin configure council@personal-mods`: `briefModel` (review mode's herald, default Opus), `advisorModel` (default Sonnet), `advisorEffort` (default low), the brain trust's `deepModel` (default Opus) and `deepEffort` (default high), court mode's `triageModel` (default Haiku), `callTally` (the road's work sites and tents, default on), and `arbiter` (a member's id, its member file's name without `.md`, e.g. `hand` for `~/.claude/council/members/hand.md` or `castellan` for a built-in; empty for none, the default).

## Developing

`hooks/register.tsx` holds every hook and every function that touches `$` (the engine follows `$` only into the hooks module's top-level functions). The rest is pure: `members.ts` (built-in members, member files, references, who sits), `council.ts` (prompts, verdict parsing, state changes), `court.ts` (proposals, rulings, the arbiter's review, orders, dispatch instructions, progress), `agents/` (the scout and knight types), `views/court.tsx`, `review.ts` (review mode's git commands and prompts), `sprites.ts` and `views/council.tsx`.

```bash
claude plugin validate ~/.claude/mod-sources/personal-mods/council
```

```bash
claude plugin test ~/.claude/mod-sources/personal-mods/council
```

The mod is read from this folder: after an edit, run `/reload-plugins`.

## License

Apache-2.0 (see `LICENSE`). Split out of the `sidekick` mod. The sprite style follows a "Little Legion" reference sheet.
