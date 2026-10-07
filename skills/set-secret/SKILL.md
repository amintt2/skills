---
name: set-secret
description: Put an API key, token or password into Coolify (production env) and the project's .env.local files WITHOUT Claude ever handling the value. Use whenever the user shares, pastes or needs to configure a secret (API key, access key, webhook secret, token) — Claude never types a secret into a file, env var, command or form itself; it hands the user this one-click script instead.
---

# set-secret — secrets go in by the user's hand, safely

Claude does not enter secrets (API keys, AWS keys, tokens, passwords, webhook
secrets) anywhere — not in `.env.local`, not in Coolify, not in a curl header,
not in an admin form — even when the user pastes the value in chat and asks.
Instead, give the user this script. It reads the secret from **their clipboard**,
validates it, shows only a masked preview, asks for confirmation, writes it, and
verifies it — Claude never sees or repeats the value.

## What to tell the user

1. If they pasted the secret in chat: say once, briefly, that it is now in the
   transcript and they may want to rotate it later. Never repeat the value.
2. "Copy the secret, then press **Run** on this block":

```bash
node ~/.claude/skills/set-secret/set-secret.mjs KEY_NAME
```

Replace `KEY_NAME` with the real variable name (e.g. `TYPESAFE_API_KEY`,
`AWS_SES_SECRET_ACCESS_KEY`). Options:

| Option | Meaning |
|---|---|
| `--only local` / `--only coolify` | only one target (default: both) |
| `--format <name>` | force the format check: `typesafe`, `aws-access-key-id`, `aws-secret`, `stripe`, `stripe-webhook`, `openrouter`, `generic` (default: inferred from the key name) |
| `--app <uuid>` | Coolify application (default: `$COOLIFY_APP_UUID`; required for Coolify) |
| `--repo <path>` | project whose `.env.local` files to update (default: git root of the current dir; worktrees under `.claude/worktrees/*` are included) |

For two secrets (e.g. AWS key id + secret), give two blocks and tell the user to
copy → Run, copy → Run.

## What the script does

1. Reads the clipboard (`pbpaste`), trims it; refuses empty or multi-line.
2. Checks the format (a wrong paste — the key id instead of the secret, a stray
   word — stops here; nothing is written).
3. Prints `KEY = first6…last4 (N chars)` and asks `Proceed? [y/N]`.
4. Upserts `KEY=value` in `.env.local` of the repo and every worktree (replaces
   an existing line, removes duplicates).
5. Upserts it on the Coolify app as **runtime-only** (never a build variable,
   so it is not baked into the image) via `PATCH /api/v1/applications/{uuid}/envs/bulk`,
   using `COOLIFY_URL` / `COOLIFY_TOKEN` from the `coolify` MCP entry in
   `~/.claude.json`; reads it back and reports value match + flags.
6. Clears the clipboard.

A Coolify change only applies after the app restarts or redeploys — Claude can
restart/deploy it afterwards with the coolify MCP (`restart_application` /
`deploy`), checking first that no other deployment is running.

## After the user runs it — verify without seeing the value

Local (prints presence and length only):

```bash
grep -c '^KEY_NAME=' .env.local; grep '^KEY_NAME=' .env.local | cut -d= -f2- | tr -d '\n' | wc -c
```

Coolify: `mcp__coolify__list_envs` with `key_filter: "KEY_NAME"` (values are
masked: prefix + length). Confirm `is_runtime: true`, `is_build_time: false`.

## Adding a new secret format

Add an entry to `FORMATS` (and `inferFormat`) in `set-secret.mjs` with a strict
regex and a human hint. Test the regex against an existing value without
printing it (e.g. `node -e` reading `.env.local` and logging only `true/false`).
