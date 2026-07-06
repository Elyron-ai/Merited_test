#!/usr/bin/env node
// PostToolUse hook: when an Edit/Write touches the launch-readiness register (or
// this tool's own source), rebuild docs/launch-readiness.html. Wired in
// .claude/settings.json. Fast + silent on every other edit; never throws.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const WATCH = [
  "docs/launch-readiness.md",
  "tools/launch-readiness/guides.json",
  "tools/launch-readiness/template.html",
];

async function main() {
  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch { /* no stdin — nothing to do */ }

  let fp = "";
  try {
    const ev = JSON.parse(raw || "{}");
    fp = (ev.tool_input && (ev.tool_input.file_path || ev.tool_input.path)) || "";
  } catch { /* not JSON — ignore */ }
  if (!fp) return;

  const rel = path.relative(ROOT, path.resolve(fp)).replace(/\\/g, "/");
  if (!WATCH.includes(rel)) return; // not the register — no-op

  const r = spawnSync("node", [path.join(here, "generate.mjs")], { cwd: ROOT, encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0 && r.stderr) process.stderr.write(r.stderr);
}

main().catch(() => {}).finally(() => process.exit(0));
