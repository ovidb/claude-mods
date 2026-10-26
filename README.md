# Claude Mods by ovidb

Four mods for Claude Code: guard rails before risky commands, a live view of subagents, a second pair of eyes on each turn, and a readable report at the end. Each one draws in the terminal, the desktop app's Code tab, VS Code and the Claude mobile app.

| Mod | What it does | Commands |
| --- | --- | --- |
| [Blast Radius](plugins/blast-radius) | Holds risky shell commands and shows exactly what they would delete or discard before you approve them. | `/blast-radius` |
| [Savvy Progress](plugins/savvy-progress) | A live band and panel showing every subagent: what it is doing, its model, its steps and roughly what it costs. | `/agents-info` |
| [You Should Know](plugins/you-should-know) | A cheap second reviewer that flags the consequences of a turn you might miss. | `/ysk` |
| [Session Report](plugins/session-report) | Writes an HTML report of the session: turns, cost, files changed, commands, subagents and notes. | `/report` |

## Install

Mods need Claude Code 2.1.287 or newer. At the prompt of a terminal session:

```
/plugin install blast-radius --marketplace ovidb/claude-mods
/plugin install savvy-progress --marketplace ovidb/claude-mods
/plugin install you-should-know --marketplace ovidb/claude-mods
/plugin install session-report --marketplace ovidb/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads the mod in every session).

From a shell, outside Claude Code:

```
claude plugin install blast-radius --marketplace ovidb/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ovidb/claude-mods`, then Add plugin.

To try one for a single session from a clone: `claude --plugin-dir ./plugins/blast-radius`.

## On your phone

Every band and panel has a compact layout for narrow screens and the mobile app. Blast Radius asks in Claude Code's own question dialog, so you can see what a delete would remove and answer from your phone. You Should Know can send a system notification when it raises a note, and Session Report gives a short summary in the chat when you run `/report` from a phone.

## What they can see and do

A mod runs with your permissions, so here is exactly what these do:

- **Blast Radius** reads each Bash command before it runs. For risky ones it runs read-only `find`, `du` and `git` queries in your project to measure them. It never runs the command itself.
- **Savvy Progress** reads token counts from model responses and the list of running agents. It runs no commands and writes no files.
- **You Should Know** sends a digest of each turn that changed something (your request, Claude's replies, edits and commands, trimmed) to a small model through your own Claude Code session, so it counts toward your usage. It keeps the topics you mark as known in the mod's own store.
- **Session Report** keeps a journal of the session in memory and writes HTML files to `~/.claude/session-reports` (configurable). It runs `git rev-parse` for the branch name and `open` to show the report.

None of them make network requests of their own.

## Costs are estimates

Savvy Progress and Session Report price tokens with Anthropic's published list prices (cached October 2026). Partner platforms such as Bedrock or Vertex price differently, and subscription plans do not bill per token. Session Report shows the session total the way `/cost` counts it when the engine reports one.

## Developing

Each mod is a folder with `.claude-plugin/plugin.json`, `hooks/hooks.json` and a TypeScript hooks module. To check and test one:

```
claude plugin validate plugins/blast-radius
claude plugin test plugins/blast-radius
```

## License

MIT, see [LICENSE](LICENSE).
