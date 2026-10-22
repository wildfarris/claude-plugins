---
name: setup
description: Set up the person's council profile (how strictly the council votes, the scale it judges at, what they weigh first, and notes on where the work runs) by a short interview, then write it to their profile file. Use when the person runs /council:setup or asks to set up or change their council profile.
disable-model-invocation: true
---

# Set up the council profile

You are helping the person write their council profile: a small markdown file the
council plugin reads before every sitting. Everything in it is optional; with no file
the council votes "balanced" at no particular scale, so the person may skip any
question, or all of them.

Interview them briefly, **one topic at a time**, in the order below. Ask each question
on its own (use the AskUserQuestion tool where you have it, with the choices listed;
otherwise ask in plain text and wait). If they decline, say "skip", or don't care,
leave that field out and move on. Don't ask follow-ups beyond what each step says, and
never invent a value they didn't give.

## 0. Read what is there

Read both profile files if they exist, so you can show the current values as the
defaults and keep fields the person doesn't change:

- `~/.claude/council/profile.md`: applies everywhere.
- `<session root>/.claude/council/profile.md`: applies to this project only, and wins
  field by field over the first.

`/council profile` shows the profile in effect and where each field comes from.

## 1. Where it applies

Ask: everywhere (their own file in `~/.claude/council/`) or only this project
(`.claude/council/profile.md` at the session root). Mention that a project file sits
in the repository, so it may be committed and seen by others, and that its fields win
over their own file's.

## 2. Strictness

How hard the council votes, from -2 to +2:

- **-2 lenient**: "Reserve 3+ for things that would really hurt; small risks are
  fine." Only concerns of 4 or more put conditions on the work.
- **-1 relaxed**: real problems get flagged; minor or theoretical ones pass.
- **0 balanced** (the default): the concern scale as written; 3 or more is a condition.
- **+1 firm**: anything with a plausible way to go wrong gets a 3.
- **+2 strict**: "Flag anything you'd want a second look at." Concerns of 2 or more
  become conditions.

A concern of 5 always refuses a plan, at every level, and no level lowers a concern
about exposed credentials, data loss, anything irreversible, or acting outside what
the person asked.

## 3. Scale

What the work really runs at, so the council judges risk, cost and process in
proportion. Offer the presets:

- **personal**: just them, on their own machines and accounts.
- **small-team**: a handful of people who know each other.
- **small-business**: real customers, modest traffic.
- **public**: open to anyone on the internet.
- **enterprise**: many users and teams, audits and compliance.

Then ask whether they want to add a sentence or two in their own words, for example:
"Vote as if this only ever runs at a low-traffic cafe, even if it looks like an
enterprise app." That text becomes the notes (the file's body). Keep the notes under
1,500 characters, and never put secrets, credentials or other people's personal data
in them.

## 4. Priorities

Ask them to rank what they weigh first when concerns conflict, for example
maintainability, security, cost, speed of delivery, simplicity, privacy. Up to 6
items, each a short phrase of at most 40 characters, most important first.

## 5. Members (optional)

Ask whether they want to change who sits on the council. If so, point them to
`/council members` (a list with a switch per member) or
`/council members on|off <member>`; member files themselves are covered in the
council plugin's README. Don't change seats yourself.

## Write the file

Write only the file they chose in step 1, creating `.claude/council/` if needed. Keep
any field already in that file that they didn't change; leave out every field they
skipped. Use exactly this format (YAML-style header, notes as the body):

```markdown
---
strictness: -1
scale: small-business
priorities:
  - maintainability
  - security
  - cost
---
A cafe's ordering app: one shop, one tablet, a few hundred orders a day.
Vote as if it only ever runs there, even where it looks like an enterprise app.
```

- `strictness`: a whole number from -2 to 2 (or its label: lenient, relaxed,
  balanced, firm, strict).
- `scale`: one of personal, small-team, small-business, public, enterprise.
- `priorities`: a list, at most 6 items of at most 40 characters each.
- No other header fields: the plugin reports unknown fields as problems.

If they skipped everything, write nothing and say the council stays balanced with no
scale.

Then show them the file as written, and suggest `/council profile` to check what the
council now reads (and any problems it found). The profile applies from the next
sitting; a council already in session keeps the profile it convened with.
