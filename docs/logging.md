# Session logging

Max persists Copilot session events as newline-delimited JSON in `~/.max/session-logs/`.

- Default log directory: `~/.max/session-logs/`
- Run-id to file mapping: `~/.max/session-logs/<run-id>.jsonl`
- Path resolution is sanitized the same way as the implementation: any run-id character outside `[A-Za-z0-9._-]` is replaced with `_`

## Shell example with `MAX_SESSION_LOG`

`MAX_SESSION_LOG` is useful as a shell convenience when you want to inspect a specific log file directly:

```bash
export MAX_SESSION_LOG="$HOME/.max/session-logs/<run-id>.jsonl"
tail -n 20 "$MAX_SESSION_LOG"
```

The built-in tail commands below resolve the file from the run-id instead of reading `MAX_SESSION_LOG`.

## Tailing a session log

CLI:

```bash
max session-log-tail <run-id>
max session-log-tail <run-id> --lines 50
```

- Default line count: `20`

Telegram:

```text
/session-tail <run-id>
/session-tail <run-id> 50
```

- `N` must be a positive integer
- Telegram uses the same default (`20`) and caps the response at `50` lines
