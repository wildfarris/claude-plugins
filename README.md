# claude-plugins

A Claude Code plugin marketplace, `personal-mods`, holding three plugins: `sidekick`, `council` and `commons`. Each plugin lives in its own folder with its own README, manifest and LICENSE, and installs on its own.

## The plugins

### sidekick

A bar above the prompt (TL;DR briefs from a session record, heads-up, rules, replay), a multi-repo scope guard that keeps a session's changes inside its target folder, long-lived rules, a resume warning, trimming instead of summary compaction, and tools that let Claude ask the Codex and Antigravity CLIs, with your approval on every call. See [sidekick/README.md](sidekick/README.md).

### council

Convenes a council of five advisors on a question or on a repo's recent work. Each weighs one concern, answers with a 1-5 concern and a short verdict, and is drawn as an animated pixel portrait. It also has review mode, a brain trust mode, and orders for scouts and knights across several folders. See [council/README.md](council/README.md).

### commons

Memory shared across projects, by topic. A sidebar turns each topic on or off per project, and Claude reads and saves to the topics in any session, without mounting every repo into one session. See [commons/README.md](commons/README.md).

## Install

Add the marketplace, then install the plugins you want:

```
/plugin marketplace add wildfarris/claude-plugins
/plugin install sidekick@personal-mods
/plugin install council@personal-mods
/plugin install commons@personal-mods
```

Each plugin installs independently of the others. Settings are set with `/plugin configure <name>@personal-mods`.

## Council and sidekick together

The two work alone, and each does more with the other installed:

- With sidekick installed, its bar shows a council button (`councilButtonEnabled`, on by default), and its scope guard also holds a council knight's shell commands to the knight's folder.
- Without sidekick, only a knight's file edits are held to the folder, not its shell commands.

Install both if you use knights.

## License

There is no LICENSE file at the root of this repo. Each plugin carries its own, and `sidekick/LICENSE`, `council/LICENSE` and `commons/LICENSE` are all the Apache License 2.0, as is the `license` field in each plugin's manifest. The replay in sidekick is adapted from Anthropic's `replay-theater` sample mod; [sidekick/README.md](sidekick/README.md) has the attribution.
