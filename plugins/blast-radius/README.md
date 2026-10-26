# Blast Radius

Holds risky shell commands and shows exactly what they would delete or discard, before you approve them.

When Claude is about to run a command that removes work, Blast Radius measures it with read-only queries and asks you first, in Claude Code's own question dialog: "`rm -rf build` would delete 212 files (8.4 MB): build/app.js, … Run it?" with **Stop it** and **Run it**. A band above the prompt lists the paths. The command runs only on an explicit Run it; anything else stops it and tells Claude not to retry without asking.

The check runs before any permission decision, so it holds in auto mode and alongside policy plugins that decide permissions first. It can only stop a command, never allow one your permissions would refuse. A command that would remove nothing (a delete of a folder that does not exist) passes through untouched.

## What it catches

| Command | What it measures |
| --- | --- |
| `rm -r`, `rm -rf`, `rm` with a glob | every file under the targets, with total size |
| `git clean -f` (with `-d`, `-x`, `-X`) | the untracked files `git clean -n` lists |
| `git reset --hard [ref]`, `git checkout -f` | uncommitted changes lost, and commits the branch moves off |
| `git checkout -- <paths>`, `git restore <paths>` | changes thrown away, with line counts |
| `git push --force`, `-f`, `--force-with-lease`, `+refspec` | remote commits you do not have locally (as of your last fetch) |
| `git branch -D` | commits found on no other branch or remote |
| `git stash drop`, `git stash clear` | the stashes and their files |
| `find … -delete`, `find … -exec rm` | what the same `find` matches |
| `xargs rm`, `rsync --delete`, targets built from `$VARS` | held, marked as not measurable |

`cd dir && …` and `git -C dir …` are followed, so the measurement runs in the right folder.

## Use

- Answer the Blast Radius question. Stop it is the safe choice. It works the same from the mobile app.
- `/blast-radius` opens a pane with the full list for the latest hold and the history of this session. Where no pane can open (the phone), it answers in the chat.

## Caveats

It is a safety net, not a permission system: keep your normal permissions on. It needs `bash`, `find`, `du` and `git`. Force-push measurements are only as fresh as your last `git fetch`.
