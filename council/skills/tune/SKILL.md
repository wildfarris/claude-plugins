---
name: tune
description: Tune single council members (what each should weigh especially, what it should set aside, and whether it votes softer or harder) by a short walk through their recent votes, then write cares, ignores and lean to their member files. Use when the person runs /council:tune or asks to tune a council member.
disable-model-invocation: true
---

# Tune council members

You are helping the person tune one or more members of their council. Tuning is three
optional fields in a member's file that **add to** its remit and never replace it:

- `cares`: up to 5 things this member should weigh especially;
- `ignores`: up to 5 things it should set aside;
- `lean`: whether it votes softer or harder than the council's strictness: `softer`
  (-2), `slightly-softer` (-1), `as-is` (0), `slightly-harder` (+1), `harder` (+2).
  Softer means lower concerns; harder means higher ones. Lean changes only how this
  member rates; the thresholds at which the council puts conditions on work or
  refuses it stay as the profile sets them.

Nothing set aside and no softer lean ever lowers a member's concern about exposed
credentials, data loss, anything irreversible, or acting outside what the person
asked; the plugin tells the member so.

Keep it short: one member at a time, a few votes each, and a draft the person accepts,
edits or skips. Ask each question on its own (use the AskUserQuestion tool where you
have it; otherwise ask in plain text and wait). If they say "skip", or don't care, move
on. Never invent a value they didn't give or agree to.

## 1. Which members

List the members seated here with their concern, for example "The Castellan
(Security)". The five built-ins are castellan, treasurer, seneschal, justiciar and
jester; the person's own members are the `.md` files in `~/.claude/council/members/`
and `<session root>/.claude/council/members/` (the id is the file name without
`.md`). `/council members` shows who is seated and any tuning already in place. Ask
which ones to tune; they may pick several.

## 2. Where it applies

Ask: everywhere (`~/.claude/council/members/<id>.md`) or only this project
(`<session root>/.claude/council/members/<id>.md`). Say that a project file sits in
the repository, so it may be committed and seen by others, and that its fields win
over their own file's field by field. Read both files for each chosen member now, if
they exist, so you can show what is already set.

## 3. Each member, one at a time

### a. Who it is

Show its concern and remit in two lines: its title and concern, then its remit cut
to about 200 characters. A built-in's remit is in the council plugin's
`hooks/members.ts` (`BUILT_IN_MEMBERS`) unless a member file replaces it; a member
file's remit is the text below its header. Also show any cares, ignores or lean
already set, and which file holds them.

### b. Its recent votes, from the docket

The docket records every sitting of the council:

- Folder: `~/.claude/council/docket/<project key>/`. The project key is the session
  root as a slug (lowercase letters, digits and dashes, its last 40 characters) plus
  `-` and an eight-digit hex hash, e.g. `claude-workspace-1a2b3c4d`. List
  `~/.claude/council/docket/` and pick the folder whose slug ends like this
  project's root; confirm it by the `project` field of its entries, which must equal
  the session root. If none matches, there is no history here.
- Files: one per calendar day, `MM-DD.jsonl` (UTC), plus a `lock` file to leave
  alone. Read them newest first (by their entries' `time`, since the names wrap
  round each year), and stop once you have 5 votes or have read about 14 days.
- Format: one JSON object per line. Skip any line that doesn't parse or whose `v` is
  not `1`. The fields that matter here: `time` (ISO), `kind` (consult, orders,
  summons, amendment, court, council, leave, advise, recall), `project`, `question`
  or `plan` (what was judged), `outcome` (approved, refused, held, adjourned,
  dissolved, a consult's `option 2`, `advice`…), and `votes`: one per member, each
  `{ "id", "title", "status", "concern", "verdict", "detail" }`, where `status` is
  `done`, `abstained` or `failed` and `concern` is 1 to 5 (0 when none).

Pick this member's votes (`votes[].id` equal to its id) with `status` `done` and
`concern` 3 or more, newest first, at most 5. Show each on one line: the question or
plan cut to about 80 characters, its concern and verdict, and the outcome. For
example: `4/5 "Rotate the key first." on "Add a deploy script that…" (approved)`.

Then ask what the person makes of them: which were right, which over-flagged, and what
it missed. With no docket history, or no such votes, ask directly instead: "What does
this member flag that you don't care about, or miss that you do?"

The docket can hold sensitive text. Show only these few lines, and don't save, log or
copy them anywhere.

### c. A draft to accept, edit or skip

From what the person said, propose a draft, for example:

```
cares:   - tokens in CI logs
ignores: - internal admin tools on the lab VLAN
lean:    slightly-softer (votes a little lower)
```

Word each item in the person's own words, as a short phrase. Propose a lean only when
they said the member votes too hard or too soft overall; otherwise leave lean as it
is. Ask them to accept it, edit it, or skip this member.

Limits (the plugin reports anything else as a problem in `/council members`):

- at most 5 items each in `cares` and `ignores`;
- each item 3 to 160 characters, on one line, with no `<` or `>`;
- `lean` a whole number from -2 to 2, or its label.

Never put secrets, credentials, tokens or other people's personal data in tuning, and
don't copy docket text (questions, plans, verdicts) into the file: only the person's
own words.

## 4. Write the file

For each accepted member, write only the file chosen in step 2, creating
`.claude/council/members/` if needed.

- If the file exists, keep everything in it that the person didn't change: change only
  `cares`, `ignores` and `lean`, and add them to the header if missing. Never touch
  `title`, `concern`, `color`, `accessory`, `references`, the remit (the text below
  the header), or any other field.
- If it doesn't exist and the member is a built-in, or one of the person's own members
  being tuned for this project only, write a header with just the tuning fields and no
  body: the rest comes from the built-in or from their own file.
- Use the member file's YAML-style header, lists one `- item` per line:

```markdown
---
cares:
  - tokens in CI logs
ignores:
  - internal admin tools on the lab VLAN
lean: slightly-softer
---
```

Then show the merged result for each member: the tuning that will apply here, field
by field, and which file each field comes from (a project file's fields win over the
person's own file's; a field the project file leaves out comes from theirs). Suggest
`/council members` to check it, where each tuned member shows a line like
`tuned: lean: slightly-softer · cares 1 · ignores 1` and any problems are listed.
Tuning applies from the next sitting; a council already in session keeps the members
it convened with.
