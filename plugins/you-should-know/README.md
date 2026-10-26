# You Should Know

A second, cheap reviewer that reads what Claude just did and flags the consequences you might miss.

After each turn that edited files or ran commands, a small model reads a trimmed digest of the turn: your request, Claude's replies, the edits and the commands. It stays quiet unless it finds something that clears a high bar: data loss, double charges, non-idempotent retries, security holes, breaking API or schema changes, silent behaviour changes, or a mismatch between what you asked and what was done. When it does, a band appears above the prompt.

## The band

- **Learn more** shows why it matters and what to check, then offers **Ask Claude about it**.
- **Knew this already** remembers the topic, so it is never raised again.
- **Dismiss** puts the note away. Sending your next prompt does too.

Each note is also kept in the transcript as a notice (Claude never reads it), so you still see it when you scroll back or open the session on another device. It can send a system notification as well.

## Commands

`/ysk` shows status and spend. `/ysk on` and `/ysk off` switch it. `/ysk now` reviews the last turn even if it changed nothing. `/ysk history` lists this session's notes. `/ysk forget` clears the known topics.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Reviewer model | `haiku` | `haiku`, `sonnet` or `opus` |
| Review when | `changes` | `changes` reviews turns that edited or ran something; `every-turn` reviews all |
| Notify | on | also send a system notification for each note |

## Caveats

Each review is one extra model call through your own session, so it uses a little of your plan or API budget. On a strong model it often stays quiet: that is the point.
