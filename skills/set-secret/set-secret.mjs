#!/usr/bin/env node
// Put a secret where Mailbase reads it — WITHOUT it ever being typed into a
// chat, a command line or a log. You copy the secret, run this, confirm.
//
//   node ~/.claude/skills/set-secret/set-secret.mjs TYPESAFE_API_KEY          # Coolify + local
//   node ~/.claude/skills/set-secret/set-secret.mjs STRIPE_SECRET_KEY --format stripe
//   node ~/.claude/skills/set-secret/set-secret.mjs SOME_KEY --only local      # or --only coolify
//   … --app <coolify app uuid>   (default: Mailbase production, mailbase:main)
//   … --repo <path>              (default: the git root of the current directory)
//
// What it does, in order:
//   1. reads the secret from the clipboard (pbpaste), trims it;
//   2. checks it is one line, non-empty, and matches the expected format
//      (inferred from the key name, or --format) — a wrong paste stops here;
//   3. shows a masked preview (first 6 … last 4, length) and asks to confirm;
//   4. writes KEY=value into .env.local of the repo and of every worktree
//      under .claude/worktrees (replacing an existing line, never duplicating);
//   5. upserts it on the Coolify app as a RUNTIME-only variable (not a build
//      variable, so it is not baked into the image), using the Coolify URL and
//      token from the coolify MCP entry in ~/.claude.json, then reads it back
//      to confirm it landed (length check — the value is never printed);
//   6. clears the clipboard.
// The value is never printed, logged or passed as an argument.
//
// A Coolify change applies on the next restart/deploy of the app.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

// The project whose .env.local files are updated: --repo, else the git root of
// the directory the script is run from (the main checkout, not a worktree).
function gitRoot(dir) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8" }).trim();
    return resolve(common, "..");
  } catch {
    return resolve(dir);
  }
}
const DEFAULT_APP = "s13zq7mqf80t31twmo0is7gg"; // mailbase:main

// Known secret shapes. Inferred from the key name when --format is absent.
const FORMATS = {
  typesafe: { re: /^apikey_[0-9a-f]{16,}_[0-9a-f]{64}$/, hint: "apikey_<hex>_<64 hex>" },
  "aws-access-key-id": { re: /^(AKIA|ASIA)[0-9A-Z]{16}$/, hint: "AKIA + 16 uppercase letters/digits" },
  "aws-secret": { re: /^[A-Za-z0-9/+]{40}$/, hint: "40 characters of A-Z a-z 0-9 / +" },
  stripe: { re: /^(sk|rk)_(live|test)_[A-Za-z0-9]{20,}$/, hint: "sk_live_… / sk_test_… / rk_…" },
  "stripe-webhook": { re: /^whsec_[A-Za-z0-9+/=]{20,}$/, hint: "whsec_…" },
  openrouter: { re: /^sk-or-v1-[0-9a-f]{64}$/, hint: "sk-or-v1-<64 hex>" },
  generic: { re: /^\S{8,}$/, hint: "8+ characters, no spaces" },
};
function inferFormat(key) {
  if (/^TYPESAFE_/.test(key)) return "typesafe";
  if (/ACCESS_KEY_ID$/.test(key)) return "aws-access-key-id";
  if (/SECRET_ACCESS_KEY$/.test(key)) return "aws-secret";
  if (/^STRIPE_WEBHOOK/.test(key)) return "stripe-webhook";
  if (/^STRIPE_.*(SECRET|KEY)/.test(key)) return "stripe";
  if (/OPENROUTER/.test(key)) return "openrouter";
  return "generic";
}

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}
function mask(v) {
  return v.length <= 12 ? `${"•".repeat(v.length)} (${v.length} chars)` : `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)`;
}

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith("--") && !["--format", "--only", "--app", "--repo"].includes(args[args.indexOf(a) - 1]));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
  die("usage: node ~/.claude/skills/set-secret/set-secret.mjs KEY_NAME [--format typesafe|aws-access-key-id|aws-secret|stripe|stripe-webhook|openrouter|generic] [--only local|coolify] [--app <coolify uuid>] [--repo <path>]");
}
const formatName = opt("format") || inferFormat(key);
const format = FORMATS[formatName];
if (!format) die(`unknown --format ${formatName} (known: ${Object.keys(FORMATS).join(", ")})`);
const only = opt("only");
if (only && !["local", "coolify"].includes(only)) die("--only must be local or coolify");
const app = opt("app") || DEFAULT_APP;
const REPO = opt("repo") ? resolve(opt("repo")) : gitRoot(process.cwd());

// ── 1-2. clipboard + validation ─────────────────────────────────────────
let value;
try {
  value = execFileSync("pbpaste", { encoding: "utf8" });
} catch {
  die("could not read the clipboard (pbpaste). Copy the secret first.");
}
value = value.replace(/^\s+|\s+$/g, "");
if (!value) die("the clipboard is empty — copy the secret first.");
if (/[\r\n]/.test(value)) die("the clipboard holds several lines — copy only the secret.");
if (!format.re.test(value)) {
  die(`the clipboard does not look like a ${formatName} secret (expected ${format.hint}; got ${mask(value)}). Nothing was written.`);
}

// ── 3. confirm ───────────────────────────────────────────────────────────
const targets = [];
if (only !== "coolify") targets.push("local .env.local files");
if (only !== "local") targets.push(`Coolify app ${app} (runtime only)`);
console.log(`\n${key} = ${mask(value)}   format: ${formatName} ✓`);
console.log(`Will write to: ${targets.join(" + ")}${only !== "coolify" ? `\n  repo: ${REPO}` : ""}`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question("Proceed? [y/N] ")).trim().toLowerCase();
rl.close();
if (answer !== "y" && answer !== "yes") die("cancelled — nothing was written.");

// ── 4. local .env.local files ────────────────────────────────────────────
function upsertEnvFile(file) {
  const src = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = src.split("\n");
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let found = false;
  const out = [];
  for (const line of lines) {
    if (re.test(line)) {
      if (!found) out.push(`${key}=${value}`); // keep the first slot, drop duplicates
      found = true;
    } else out.push(line);
  }
  if (!found) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.splice(out.length - 1, 0, `${key}=${value}`);
  }
  writeFileSync(file, out.join("\n"));
  const check = readFileSync(file, "utf8").split("\n").filter((l) => re.test(l));
  return check.length === 1 && check[0] === `${key}=${value}`;
}
if (only !== "coolify") {
  const files = [join(REPO, ".env.local")];
  const wt = join(REPO, ".claude", "worktrees");
  if (existsSync(wt)) {
    for (const d of readdirSync(wt)) {
      const f = join(wt, d, ".env.local");
      if (existsSync(f)) files.push(f);
    }
  }
  for (const f of files) {
    console.log(`${upsertEnvFile(f) ? "✓" : "✖"} ${f.replace(REPO + "/", "")}`);
  }
}

// ── 5. Coolify ───────────────────────────────────────────────────────────
function coolifyConfig() {
  const cfgPath = join(homedir(), ".claude.json");
  if (!existsSync(cfgPath)) return null;
  const found = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (k === "coolify" && v?.env?.COOLIFY_URL && v?.env?.COOLIFY_TOKEN) found.push(v.env);
      else walk(v);
    }
  };
  walk(JSON.parse(readFileSync(cfgPath, "utf8")));
  return found[0] || null;
}
if (only !== "local") {
  const cfg = coolifyConfig();
  if (!cfg) die("no coolify MCP entry with COOLIFY_URL and COOLIFY_TOKEN in ~/.claude.json — Coolify not updated.");
  const base = `${cfg.COOLIFY_URL.replace(/\/+$/, "")}/api/v1`;
  const headers = { Authorization: `Bearer ${cfg.COOLIFY_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" };
  const res = await fetch(`${base}/applications/${encodeURIComponent(app)}/envs/bulk`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      data: [{ key, value, is_preview: false, is_runtime: true, is_buildtime: false, is_build_time: false }],
    }),
  });
  if (!res.ok) die(`Coolify answered ${res.status} — not updated. ${(await res.text()).slice(0, 200).replaceAll(value, "[secret]")}`);
  const list = await fetch(`${base}/applications/${encodeURIComponent(app)}/envs`, { headers }).then((r) => (r.ok ? r.json() : []));
  const row = (Array.isArray(list) ? list : []).find((e) => e.key === key && !e.is_preview);
  if (!row) die("Coolify accepted the change but the variable is not listed — check the app.");
  const same = typeof row.value === "string" ? row.value === value : null;
  const buildTime = row.is_buildtime ?? row.is_build_time;
  console.log(`✓ Coolify ${key}: ${same === false ? "VALUE MISMATCH ✖" : same ? "value matches" : "set (value not readable)"}, runtime ${row.is_runtime !== false ? "on" : "OFF"}, build ${buildTime ? "ON ✖" : "off"}`);
  console.log("  Applies on the next restart or deploy of the app.");
}

// ── 6. clear clipboard ───────────────────────────────────────────────────
try {
  execFileSync("pbcopy", { input: "" });
  console.log("✓ clipboard cleared");
} catch {
  /* not fatal */
}
