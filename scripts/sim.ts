/**
 * Synthetic user simulator — invents personas and converses with the headless bot.
 *
 * Usage:
 *   npx tsx scripts/sim.ts --n 5
 *   npx tsx scripts/sim.ts --n 10 --scenarios why_not_losing,messy_hinglish_log
 *   npx tsx scripts/sim.ts --n 3 --concurrency 2 --out data/transcripts
 *
 * Uses DB_PATH=data/sim.db by default (never touches fitness.db).
 */
process.env.DB_PATH ??= "data/sim.db";
// Bot token unused in sim; satisfy any accidental imports.
process.env.TELEGRAM_BOT_TOKEN ??= "sim-unused";

const { resolveScenarios } = await import("../src/sim/scenarios.js");
const { runMany } = await import("../src/sim/runner.js");
const { config } = await import("../src/config.js");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return fallback;
}

const n = Number(arg("n", "3"));
const scenariosSpec = arg("scenarios", "all")!;
const outDir = arg("out", "data/transcripts")!;
const concurrency = Number(arg("concurrency", "1"));

if (!Number.isFinite(n) || n < 1) {
  console.error("--n must be a positive integer");
  process.exit(1);
}

const scenarios = resolveScenarios(scenariosSpec);

console.log(`Sim runner`);
console.log(`  n=${n}  concurrency=${concurrency}`);
console.log(`  scenarios=${scenarios.map((s) => s.id).join(", ")}`);
console.log(`  out=${outDir}`);
console.log(`  db=${config.dbPath}`);
console.log(`  models: sim=${config.modelSimUser} buddy=${config.modelBuddy} cheap=${config.modelCheap}`);
console.log("");

const started = Date.now();
const results = await runMany({ scenarios, n, outDir, concurrency });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const failed = results.filter((r) => r.error);
console.log("");
console.log(`Done in ${elapsed}s — ${results.length} runs, ${failed.length} errors`);
for (const r of results) {
  const status = r.error ? `ERR ${r.error}` : r.done_reason ?? "ok";
  console.log(`  ${r.scenario}  turns=${r.turns}  ${status}`);
  console.log(`    ${r.md}`);
}

process.exit(failed.length > 0 && failed.length === results.length ? 1 : 0);
