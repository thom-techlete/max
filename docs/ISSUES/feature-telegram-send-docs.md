---
title: Feature request: Telegram document send
author: Max
created: 2026-04-10
---

# Feature request: Allow Max to send documents to user via Telegram

Summary

Allow Max to deliver files and documents to the user over Telegram on-demand (e.g., session logs, exported reports, design docs). This request tracks implementing a secure, opt-in mechanism for Max to upload or send documents to the user's Telegram account.

Motivation

- Improves user experience by delivering artifacts directly to the user's phone or desktop.
- Useful for logs, reports, design docs, test artifacts, and PR patches.

Requirements / Proposal

- CLI: `max send-doc --file <path> --to <telegram-user-id|@me>` (or via the existing webhook helper) which uploads the file to Telegram using the local Max API.
- Telegram command: `/get-doc <run-id>` or `/get-latest <session>` to request recent logs; replies include the file as an attachment.
- Files must be served from a safe temporary location (e.g., /tmp/max-send/), with size limits and allowed MIME types configured by env vars (MAX_TELEGRAM_MAX_BYTES, MAX_TELEGRAM_ALLOWED_TYPES).
- Require explicit user opt-in: store authorized chat IDs in ~/.max/telegram-authorized.json and verify before sending.
- Respect API token and do not expose it. Use local Max API endpoints (127.0.0.1:7777) to send messages via the configured Telegram bot.

Security considerations

- Only send files to authorized chat IDs.
- Enforce size and MIME-type limits.
- Sanitize file names and avoid sending files from sensitive locations.
- Log all sends in session logs for audit.

Reference

- Related doc: docs/scheduling-recommendations.md

