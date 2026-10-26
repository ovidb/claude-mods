# Savvy Progress

See what every helper Claude starts is doing, and roughly what it costs, while it runs.

When Claude splits work across subagents, a band above the prompt shows how many of this turn's helpers have finished, a progress bar, their combined estimated cost and the elapsed time. Below it, each running helper gets a line with its task, type, model, step count, last tool and cost. When they all finish the band stays as a one-line tally until your next prompt.

## Use

- `/agents-info` opens or closes the Helpers panel: every helper this session, with steps, tool calls, how full its context is, duration and cost, plus the main thread's share and the session total as `/cost` counts it.
- `[hide]` on the band hides it until the next turn.
- On the phone, or anywhere a panel cannot open, `/agents-info` answers in the chat instead.

## Caveats

Costs are estimates from token counts and Anthropic's list prices (cached October 2026), not your bill. Subscription plans do not bill per token, and partner platforms price differently.
