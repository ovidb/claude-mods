# Session Report

A readable HTML report of your Claude Code session, written when you ask and when the session ends.

Session Report keeps a journal while you work: every turn with its prompt, duration and estimated cost, every tool call and its outcome, each file changed with lines added and removed, every subagent, commands that were stopped (by Blast Radius or by you), and notices other mods raised, such as You Should Know's notes. The report opens with stat tiles, then a cost-per-turn chart split between the main thread and helpers, then a table for each of those.

The page is one self-contained file with no scripts or outside requests. It follows your light or dark setting and reads well on a phone.

## Use

- `/report` writes the report and opens it in your browser. The chat shows a short summary and a link.
- `/report quiet` writes it without opening it.
- A report is also written when the session ends or you run `/clear`.

Reports are saved as `~/.claude/session-reports/<date>-<time>-<project>-<session>.html`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Save at session end | on | write a report when the session ends or is cleared |
| Reports folder | `~/.claude/session-reports` | where reports go; `~` is your home folder |

## Caveats

Per-turn costs are estimates from list prices. Line counts come from Claude's edit tools, so changes made through shell commands are not counted as file changes (they still appear under Commands).
