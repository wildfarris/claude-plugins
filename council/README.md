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

   A dispatch may also carry `forbid`: paths its agent may not change, when you've ruled some out. Each entry is `{ glob, ops?, reason }`: a glob relative to the dispatch's folder (`*` and `?` within a name, `**` across folders, a bare name at any depth, no `..`), the operations it forbids (`create`, `edit`, `delete`; all three when left out) and your reason, which the agent is shown. At most 8. "Do not edit tests": `{ "glob": "**/*.spec.ts", "reason": "the tests are the spec" }`; "no new CSS": `{ "glob": "*.css", "ops": ["create"], "reason": "use the theme tokens" }`. The advisors see the forbidden paths with the plan, the order stores them, the court row lists them (`forbids **/*.spec.ts · *.css (create)`), and the agent's instructions name them.

   A `forbid` entry may instead be a plain-language rule, one sentence in your words: `{ "rule": "Push nothing." }` (a bare string works too). The order stores these as its `policy`, the court row lists them (`rules: Push nothing.`), the agent's instructions name them, and with sidekick installed its policy judge reads the agent's shell commands against them (see sidekick's Policy guard). Without sidekick they are only instructions.

   A knight dispatch may also ask for `leave`: specific exceptions to sidekick's default policy that its task needs (see [Leave](#leave)).
2. **The council rules.** The advisors judge the plan as they would a question, without a fork (the plan is the brief). Any concern of 5 refuses it, with the reason; concerns of 3–4 become conditions on every order, unless an arbiter drops them (see below). Each member also rates every dispatch's level (see Levels), and may ask a fact checked first (see Summons). Approved dispatches become orders O1, O2…. Ids count up for the life of the court: clearing finished orders, withdrawing or expiry never frees one, so an id always names the same order.
3. **Claude dispatches** each order with the Agent tool, naming its order id in the description (the prompt is read only when the description names none). A council agent with no matching open order is refused, and the refusal lists the open orders. Before it starts, its task is rewritten to carry the order: its folder, its todos, the council's conditions and that folder's `CLAUDE.md`; it runs on its level's model.
4. **Each agent is held to its folder.** A knight's file edits outside the folder are refused here. With sidekick installed, its scope guard also holds the knight's shell commands to the folder, and enforces the order's `forbid` (see sidekick's Path rules: file tools and shell writers are refused, and what changed is checked when the agent stops). Without sidekick, `forbid` is only an instruction to the agent.
5. **Progress.** Each agent reports its todo list with `mcp__council__progress`, which moves it along its road. Its last answer is its report. When its turn ends with every todo checked off (or with none listed), the order is **done**; when it ends any other way than by answering (interrupted, refused, an API error), **failed**.
6. **Unsettled orders.** An agent that answers with todos still open (it stopped short, or ended its turn to wait for a background task or a timer) leaves its order **unsettled**: it keeps its place, and Claude is told in one line added to the main conversation (read by the model, hidden from you), e.g. `Council: O3 ended with 2 of 7 todos open (Run the tests; Commit). Settle it with mcp__council__settle_order.` Claude then settles it with `mcp__council__settle_order` (`id`, `outcome`, an optional short `note`): **done**, **stopped-early** (its place is freed), **failed**, or **waiting** (it will wake; it keeps its place). Only an unsettled or waiting order can be settled, and only by the main session; anything else is refused, naming its status. If the line can't be added to the conversation, it goes to Claude beside your next message instead.
7. **Withdrawing.** An approved order Claude decides not to dispatch (you changed your mind, a launch was rejected, the plan changed) is retired with `mcp__council__withdraw_orders`, given the order ids and a short reason. Only approved or held orders no agent has been sent on can be withdrawn; unknown, dispatched, settled and already withdrawn ids are refused, and the answer names which and why. A withdrawn order can't be dispatched; it is proposed again if it turns out to be needed.
8. **Expiry.** An approved (or held) order nobody dispatches expires after 24 hours (`ORDER_EXPIRY_MS` in `hooks/court.ts`) and is withdrawn with the reason "expired". The clock starts when the council approves it (for an order saved by an older version, when the court first looks at it). Dispatched orders never expire. The court checks when its pane is drawn, when you send a message, and when Claude proposes, dispatches or withdraws, so nothing runs on a timer.
9. **Lost.** At those same checks, a dispatched, unsettled or waiting order whose agent the engine no longer lists at all (`$.agent.list()`) becomes **lost**, so a vanished agent never holds its place. An agent that is listed in any status (running, waiting on a timer or a background task, idle, or ended, which a message may yet resume) is not gone. If its last answer comes after all, it is kept as the report. `/council release <order>` lets you mark an unsettled or waiting order lost yourself, freeing its place (only you can, typed at the prompt; its agent is left as it is).
10. **Wakes.** When the engine wakes an agent (a background task, a `ScheduleWakeup` timer, a message), its order goes back on the road, marked **woke**, and its next report follows the earlier one; its level's effort applies again (it keeps the model it was started on). An unsettled or waiting order still holds its place, so its wake always goes through, as does a scout's and one with no order behind it. A done, stopped-early, failed or lost knight order wakes only while no other knight holds an overlapping place; otherwise the wake is refused, which leaves its agent parked, and a toast says why. A recalled order never wakes: every wake is refused.
11. **No direct messages.** A message the model sends to an order's agent (SendMessage, addressed by its agent id, the name the dispatch gave it, or its order id) is refused, from the main session or a subagent, whatever the order's status. Claude reads the reason as the tool's answer, and it names the way instead: `Direct messages to O3 are blocked: use mcp__council__amend_order to change its task, or mcp__council__recall_order to stop it.` (a subagent is told to put it in its report to Claude). Messages from plugins, and to anyone else, pass. Agents are eager to message their dispatches, and every message is another run of the agent; these are the controlled channels.
12. **Your own word: `/council message <order> <text>`.** Typed at the prompt (or through Remote Control) only, it sends your text to the order's agent, framed as yours (`[Message from the person about order O3, sent with /council message]`). An agent that has ended its turn wakes to it, under the wake rules above. The court row shows it (`✉ you: …`, or `not delivered` with why). An order with no agent yet, or a recalled one, is refused.
13. **Amendments: `mcp__council__amend_order`.** Claude changes the task of an order under way (dispatched, unsettled or waiting) with an `id`, the `change`, its `reason` and up to 6 new `todos`. Main session only.
    - **Refused in code, with no model call:** an order not under way (an approved one: withdraw it and propose again; a settled one: propose a new order), one being recalled, a change already ruled on for that order (compared without case, punctuation or spacing), and an order that has used its `amendmentsPerOrder` (default 1; refused amendments count, so an eager caller can't loop; 0 turns amendments off). The refusal names what to do instead: recall it and propose a new order, or ask you to `/council message` it.
    - **Otherwise the council rules** as it rules on a plan, on the same thresholds: a 5 refuses, 3–4 become conditions. The brief is the order's task, its todos and progress, its conditions and earlier amendments, then the change and why. It costs one call per seated member and nothing more: no summons, no levels, no arbiter.
    - **Approved:** the plugin sends it to the agent as a framed amendment (`[Amendment to order O3, approved by the council]`) with its conditions and the todos to add, adds the todos to the order, and records the amendment. Claude is told it was sent and how many amendments are left.
    - **Refused:** Claude gets the reason; when the council called it new work, it is told to propose a new order.
    - The court row shows each one: `✎ amendment approved: …`, `refused`, or `before the council` while it sits.
14. **Recalls: `mcp__council__recall_order`** (main session only, `id` and `reason`) **or `/council recall <order> <reason>`** (yours, typed at the prompt). No council ruling. It applies to an order under way:
    - **Changes are refused.** From then on every tool call of its agent that could change anything is denied with `Recalled: <reason>. Make no more changes. Report what you changed and its state, then stop.` Only Read, Grep, Glob, TodoWrite and `mcp__council__progress` pass. A call already running when the recall lands finishes; nothing is cut short. A note with the same words is added to the agent's own conversation.
    - **The ceiling.** The agent may make 3 more model requests (`RECALL_STEPS` in `hooks/control.ts`). Its 4th is answered by the council instead of the model: a final reply saying it was recalled and listing the files it touched, which ends its turn between steps, never mid-tool.
    - **Not running:** an unsettled or waiting order is recalled at once.
    - **Recalled** is a settled status: the knight's place is freed, any later wake is refused, and the order can't be amended or messaged. The agent's final turn end moves a dispatched order to recalled, not done, unsettled or failed (and one whose agent is gone is recalled, not lost).
    - **The report** is the agent's last answer plus the files its file tools changed (Edit, Write, MultiEdit, NotebookEdit; shell changes are not tracked, and the report says so). Claude is told in one line, e.g. `Council: O3 recalled (wrong repo); touched: a.ts, lib/b.ts (shell changes are not tracked). Review or revert, then propose a new order if needed.` (when Claude itself recalls an order that is not running, its tool's answer says this instead).

**The lifecycle.** Every status change goes through one table, `ORDER_LIFECYCLE` in `hooks/court.ts`; anything it doesn't list is refused:

| From | To |
| --- | --- |
| held | approved (released by the second round), withdrawn (refused by the second round, withdraw, expiry) |
| approved | dispatched (dispatch), withdrawn (withdraw, expiry) |
| dispatched | done (answered, no todo open), unsettled (answered, todos open), failed (any other end), lost (agent gone); recalled (its turn's end, or its agent gone, after a recall) |
| unsettled | done, stopped-early, failed, waiting (settle_order); dispatched (wake); lost (agent gone, /council release); recalled (recall) |
| waiting | dispatched (wake); done, stopped-early, failed (settle_order); lost (agent gone, /council release); recalled (recall) |
| done, stopped-early, failed, lost | dispatched (wake, a knight's only while its place is free) |
| withdrawn, recalled | nothing |

**Knights one at a time.** Two knights never work in overlapping places at once: the same folder, one folder inside the other, or two folders in the same git repository (the nearest folder at or above each with a `.git`; with none found, the folders alone decide). The repository rule is there because sidekick's git backstop puts every change in a repository down to one agent. A knight holds its place while its order is dispatched, unsettled or waiting; a held one holds none, and when the second round releases it while another knight holds its place, Claude is told it must wait. A knight dispatched while an overlapping knight holds its place is refused, naming it and saying to wait for it to finish (or to settle it); a proposal whose knight would overlap one is refused before the council sits (no model calls). Several knights for one repository in one proposal are fine: they are dispatched one after another. Knights dispatched together are checked one at a time, so both can't slip through. Scouts are never held back.

**Levels.** Each order has a level from 1 to 3 that the council decides; Claude's proposal can't state one. In the same calls that rule on the plan (no extra calls), each member adds a line per dispatch, `LEVEL <n>: <1-3>` (1 a simple lookup or mechanical edit, 2 ordinary work, 3 deep reasoning or risk). The order's level is the median of the valid ratings, a half rounded up; with none, a knight is level 2 and a scout level 1. The level picks the agent's model (set at the spawn) and effort (set on each of its model requests; left alone for a model that takes no effort): `scoutLevels` (default `haiku:low,haiku:high,sonnet:medium`) and `knightLevels` (default `sonnet:medium,opus:low,opus:high`), each three `model:effort` entries. The model and effort are kept on the order, so the effort holds after a reload and after a wake. The court row shows it (`L2`), and the toast when the agent is back. `/council level <order> <1-3>` changes an approved order's level before it is dispatched; only you can (typed at the prompt, or through Remote Control).

**Summons.** A member whose concern on a plan is 3 or 4 and hinges on a fact it can't see in the brief may add `CHECK: <one question>`. If any do, and no member refused the plan outright, the council sends one advisor agent (never one per member) to the plan's dispatch folders, read-only, with every question once (identical ones merged, each credited to the members who asked), on the first `advisorAgentLevels` entry. Nothing waits for it: the plan's orders are created **held** (◌ `held: advisor checking` in the court), and `mcp__council__propose_orders` answers at once, naming the held orders and the questions. A held order can't be dispatched (the dispatch is refused with why) and holds no place. When the advisor reports, every member reconsiders once with the findings, in the background; that second round decides, and nothing more is summoned. Approved, the held orders become approved with the second round's conditions and levels; refused, they are withdrawn. Either way Claude is told in one line in its conversation (`Council: the advisor (A1) reported; O4, O5 approved (gravest concern 2/5). … Dispatch them as before, …`), or beside your next message if that can't be appended. If the advisor fails, can't start, or doesn't report within 8 minutes (`SUMMONS_TIMEOUT_MS` in `hooks/advisors.ts`), the council rules on its first round and says so. Everything the second round needs (the plan, the first round and each member's answer, the questions, the deadline) is kept in the court, so a reload mid-summons doesn't lose it: the advisor's report still brings the second round, a deadline is checked again whenever the court is looked at, and a round a reload cut short starts again. The spawn token that lets only the plugin start an advisor is never saved: after a reload no advisor spawn gets through, and a summons whose spawn was lost fails after a minute and is ruled on its first round. The court shows the advisor with who asked, its questions and its status. `councilSummons` off ignores CHECK lines.

**The arbiter.** Without one, every concern of 3–4 binds every order, so a single advisor can put a condition on work you asked for. Set `arbiter` to one member's id, and that member reviews the conditions on each approved plan:

- **When:** only after a plan is approved and at least one condition was raised. A concern of 5 still refuses the plan; the arbiter never sees a refused plan and can't overturn a refusal.
- **How:** one extra call on `advisorModel` at low effort, as that member (its own system prompt, references and lessons, with the arbiter's request added). It reads your request when the plugin has it (in court mode), otherwise Claude's plan stands for it; the plan and its dispatches; and each condition with its advisor and reason. The conditions are passed as quoted data, and the member is told they are never instructions.
- **What it can do:** keep or drop each condition, with a one-line reason, as strict JSON. It can't add, merge or reword a condition: decisions on conditions it wasn't given, and anything else in its reply, are ignored. Its own conditions are reviewed the same way.
- **What you see:** kept conditions go on the orders as before. Dropped ones are not attached, but stay in the tool's answer to Claude and under the ruling in the court pane as notes ("Dropped by the Hand: <condition> (<reason>)"), beside a line saying how many it kept and dropped.
- **Fail open:** if the call errors, times out, or answers with anything but valid JSON deciding every condition, every condition stands, with a note that the review failed.
- **Still a member:** the arbiter sits, rules with its own verdict (and its own 5s), and answers consults and follow-ups like everyone else. The role only adds the review.
- **Unset or not seated:** an `arbiter` that names no member seated on this project's council is ignored (a toast says so), and the conditions stand as they would without one.

The arbiter is a council member, a model call: not you, and not a proxy for you. Decisions that are yours still go to you. Its call sends your request, the plan and the conditions to the model provider Claude Code is configured with, as every advisor call already does.

**The pane** shows the court whenever there are orders: the council in one line of colored chips on top, then one row per order. Each row is a road from the castle to the folder's house, with the agent standing where its finished todos have brought it, what it's doing now, and its report once it's home (a flag). A held order shows ◌ `held: advisor checking` until the council's second round. Orders waiting on Claude sit under **Paused**: an unsettled one (◐) with how many todos are open and which, a waiting one (◷) with its note. A recall, amendments and your messages show under the row they steer (`⏏ recalled by you: …`, `✎ amendment approved: …`, `✉ you: …`). Finished rows sink to the bottom (✓ done, ◑ stopped early, ✕ failed, ? lost, ⏏ recalled with the files it touched, with the settling note under them), then fold away at your next message. A withdrawn order is a finished row too, greyed, with `withdrawn · <reason>` in place of a report; **clear finished** removes them. **chamber** switches to the full council view and back.

**Only the main session convenes the council.** Subagents (scouts, knights, anything else) are refused `mcp__council__consult`, `mcp__council__propose_orders`, `mcp__council__withdraw_orders`, `mcp__council__settle_order`, `mcp__council__amend_order` and `mcp__council__recall_order`.

**Court mode** (`/council court on`, or the pane's button): each prompt you type is triaged by one quick call (`triageModel`, default Haiku). Questions, explanations and chatter go straight to Claude. A prompt asking one member's opinion ("what does the Jester think about…") is sent to that member alone, and Claude gets its verdict. The triage only names a seated member; an unclear answer convenes the full council. Naming the whole council ("council", "advisors", "brain trust") always convenes everyone, and Claude gets every verdict, not only the concerns, since you asked for their view. The triage treats your prompt as data to sort, never as instructions. Prompts that ask for changes, risk or decisions wait while the council sits on them (briefed from the conversation), then enter as you typed them, with a short digest beside them that Claude sees and the transcript doesn't: the concerns at 3 or more, or one line saying there were none. While court mode is on, only council agents are dispatched. `/council court off` ends it. Slash commands and messages from plugins pass straight through.

**The strip** shows each advisor's small portrait (desktop) and name with its concern; press one to read its verdict. Finished orders fold into one line when you send your next message (not on a timer, so work that ends while you are away is still there when you come back); press it to show them again.

**Limits:**
- Progress follows the todo list the agent reports with the council's own `mcp__council__progress` tool (Claude Code's TodoWrite isn't offered to subagents in every build). If an agent doesn't report, its row shows steps and edits but stays put. If it adds todos, it steps back.
- Each row's road shows the work done. Every todo is a stop along the road: the agent stands at the first unfinished one, a finished stop shows a stack of bricks in the agent's colour (one brick per ten tool calls the agent made while that todo was in progress, up to five; the fifth brick also raises a green banner), and each stop still ahead shows a red enemy tent. Calls made when no todo is in progress (before the agent's first list, or between two todos) are not credited to any stop. In a terminal the stop shows the level as a digit 1 to 5 and the tent as ▲. The row beside it shows the totals, `N edits · N calls`. Turn the stops, bricks and tents off with the `callTally` setting; the plain road and the numbers stay.
- Without sidekick, only file edits are held to the folder, not shell commands.
- The engine has no way to stop an agent, so a recall works at the agent's own boundaries: its tool calls are refused as they start, and its 4th model request after the recall is answered by the plugin (a `turn.step` answered without the model). Only file-tool changes are tracked as touched; check shell changes yourself (e.g. `git status`).
- The message block knows an order's agent by its agent id, the name its dispatch gave it, its order id, or a teammate address from the engine's agent list. A recipient spelled any other way passes.
- An order's council sits for about a minute (five advisor calls) before work starts; an arbiter's review adds one more call when there are conditions. A summons adds one advisor agent run (Opus at low effort by default, up to 8 minutes) and a second round of member calls, only when a member asks a CHECK; `councilSummons` off avoids both.
- A summons hands the decision back later: Claude hears the second round's ruling as a line in its conversation, which it reads on its next request. If it ended its turn meanwhile, it hears at your next message, and the released orders wait for it (expiring after a day like any approved order).

## Leave

Sidekick's policy judge holds every agent to a default policy, including "Don't change installed tools, PATH, services or system settings", and it never sees the order's task. Deliberate system work (an installer on a Debian host, a service it sets up) is refused by it. Leave is the way through: exceptions declared when the order is proposed, ruled on with the plan, and added to that one order's judge policy only.

- **Asked in the proposal, never later.** A knight dispatch's `leave` is a list of up to 4 sentences, each one line of 10 to 200 characters with no `<` or `>`, each a specific exception, e.g. `"May run systemctl status and systemctl restart on units this order installs"`. Anything else is refused before the council sits: too many, too short or long, a line break, tab or other control character, angle brackets, or leave on a scout (a scout changes nothing). It is never cut short or mended, so what is ruled on is what the judge reads. `mcp__council__amend_order` refuses any amendment that carries `leave`; a recalled order is proposed again with the leave it needs.
- **Ruled on with the plan.** The brief shows each dispatch's leave (`LEAVE ASKED …`), and the members are asked to weigh it as a widening of what the agent may do on the machine. A 5 refuses the plan, leave and all. An approved order stores it.
- **Granted by you, by default.** With `leaveApproval` `owner` (the default), an approved order with leave waits: its dispatch is refused (`O3 asks for leave the person hasn't granted. Ask them to type /council grant O3, or /council deny-leave O3 to send it without; then dispatch it.`), Claude is told so in the ruling, and a toast tells you. `/council grant <order>` grants it; `/council deny-leave <order>` drops it, and the order can be dispatched without it. Both are yours only (typed at the prompt or through Remote Control; refused from a model, a plugin or a schedule), and only before the order is dispatched; Claude is told when you rule. The court row shows the leave and where it stands (`leave (waiting for you): …`, `leave (granted): …`, `leave denied: it goes without`), with **grant leave** and **deny leave** buttons while it waits. No tool grants leave.
- **Or by the council.** With `leaveApproval` `council`, leave is granted when the council approves the plan (a held order's, when the second round releases it).
- **What it does.** The agent's instructions list its granted leave. With sidekick 0.18 or later, the judge reads it for that order's agent only, as exceptions to its default rules within their own words, and the stop review reads it too (see sidekick's Policy guard). The folder, the path rules and the inline-code ban still hold. Without sidekick, leave changes nothing.

## The advisor agent

`/council advise <folder> <question>` sends the council's advisor (`council:advisor`, `agents/advisor.md`) to read one subfolder and answer your question: an agent with Read, Grep and Glob only (no shell, no edits, no council tools), told to investigate deeply, cite file paths and lines, and change nothing. `/council advise deep <folder> <question>` sends it on the second level. `advisorAgentLevels` (default `opus:low,opus:high`) sets both; it is not `advisorModel`, the members' model. It costs an Opus agent run, so it starts only when you ask (or when the council summons it, see Summons).

- **Yours alone.** Only you start one: the command is refused unless typed at the prompt (or sent through Remote Control). It is never offered to Claude, and any `council:advisor` spawn the plugin didn't make itself (Claude's, a subagent's) is refused: the plugin's own spawn carries a one-time token only it holds.
- **Scoped.** It runs in its folder, and its reads outside its folders (or any tool but Read, Grep and Glob) are refused.
- **Shown.** The court lists it under **Advisors** as a bishop (♝): where it reads, who sent it, the question, its model and effort, and its status; once back, press it for the whole report.
- **Delivered.** When it finishes, a toast says so, and its report goes to Claude beside your next message (hidden from the transcript, like the court's digests). The row folds away at the message after that.

## Settings

Set them with `/plugin configure council@personal-mods`: `briefModel` (review mode's herald, default Opus), `advisorModel` (default Sonnet), `advisorEffort` (default low), the brain trust's `deepModel` (default Opus) and `deepEffort` (default high), court mode's `triageModel` (default Haiku), `callTally` (the road's work sites and tents, default on), `arbiter` (a member's id, its member file's name without `.md`, e.g. `hand` for `~/.claude/council/members/hand.md` or `castellan` for a built-in; empty for none, the default), `scoutLevels` and `knightLevels` (what each order level runs on, see Levels), `advisorAgentLevels` (the advisor agent's two levels), `councilSummons` (whether a ruling may summon an advisor, default on), `amendmentsPerOrder` (how many amendments one order takes, refused ones included, 0 to 10, default 1; 0 turns them off), and `leaveApproval` (who grants an order's leave: `owner`, you with `/council grant`, the default; or `council`, at approval; see Leave). A malformed level setting falls back to its default.

## Developing

`hooks/register.tsx` holds every hook and every function that touches `$` (the engine follows `$` only into the hooks module's top-level functions). The rest is pure: `members.ts` (built-in members, member files, references, who sits), `council.ts` (prompts, verdict parsing, state changes), `court.ts` (proposals, rulings, the arbiter's review, orders, withdrawal and expiry, dispatch instructions, progress, levels, knight overlap, the order lifecycle: settling, releasing, lost agents and wakes), `control.ts` (steering orders under way: the message block, /council message, amendments, recalls and the recall ceiling), `advisors.ts` (the advisor agent: CHECK questions, its task, its runs), `agents/` (the scout, knight and advisor types), `views/court.tsx`, `review.ts` (review mode's git commands and prompts), `sprites.ts` and `views/council.tsx`.

```bash
claude plugin validate ~/.claude/mod-sources/personal-mods/council
```

```bash
claude plugin test ~/.claude/mod-sources/personal-mods/council
```

The mod is read from this folder: after an edit, run `/reload-plugins`.

## License

Apache-2.0 (see `LICENSE`). Split out of the `sidekick` mod. The sprite style follows a "Little Legion" reference sheet.
