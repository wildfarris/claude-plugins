# commons

A Claude Code mod: memory shared across projects, by topic. Work in separate sessions per repo and still share what matters between them, without mounting every repo into one session.

## How it works

- **Topics** hold memories: one self-contained note each, with the project that saved it and when.
- **Per project**, each topic is on or off. A topic marked **everywhere** is on in every project unless a project turns it off; otherwise it's on only where it's turned on. If you don't need per-project control, mark everything everywhere.
- **Claude reads** the topics on in this project once per conversation: their newest memories ride with your first message (up to `contextLimit` characters; older ones are named, and Claude fetches them). Turning a topic on or off applies to the next conversation, or after `/clear`.
- **Claude saves and searches** with two tools, `mcp__commons__remember` and `mcp__commons__recall`. It can save to any existing topic. Saving to a new topic name **proposes** that topic: it's on in the project that proposed it, and other projects can turn it on only after you approve it.
- **The sidebar** (`/commons`): proposed topics to approve or discard, then every topic with its switch for this project, its everywhere switch, and its memories (show, delete). **+ new topic** puts `/commons new ` in front of your draft: `/commons new Release process: how we tag`.

Commands: `/commons` (the sidebar), `/commons new <name>[: description]`, `/commons on <topic>`, `/commons off <topic>`.

## Where it lives

Plain files under `memoryDir` (default `~/.claude/commons`), never in a repo:

```
topics/<topic>/topic.json        name, description, proposed or approved, everywhere or not
topics/<topic>/<memory>.md       one memory: a header line, then its text
projects/<project>.json          which topics that project turned on or off
```

One file per memory, so two sessions saving at once never overwrite each other. The files are readable and editable by hand, and the folder can be kept in a private git repo for history and backup. It's local: sessions on other machines (mobile, cloud) don't see it.

## Trust

What one session saves, another reads. The block Claude reads frames memories as notes, not instructions, and names the project each came from. New topics need your approval before they spread, but a memory saved to an existing topic reaches every project that has it on, so look over the sidebar now and then.

## Settings

`/plugin configure commons@personal-mods`: `memoryDir` and `contextLimit` (default 6000 characters).

## Developing

`hooks/register.tsx` holds every hook and every function that touches `$`. The rest is pure: `library.ts` (file formats, switches, the text Claude reads, the tools' schemas), `settings.ts` and `views/sidebar.tsx`.

```bash
claude plugin validate ~/.claude/mod-sources/personal-mods/commons
```

```bash
claude plugin test ~/.claude/mod-sources/personal-mods/commons
```

## License

Apache-2.0 (see `LICENSE`).
