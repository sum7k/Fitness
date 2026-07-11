import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Persona } from "./persona.js";
import type { Scenario } from "./scenarios.js";
import type { TranscriptTurn } from "./simuser.js";
import { config } from "../config.js";

export interface TranscriptMeta {
  run_id: string;
  scenario: string;
  stress: string;
  persona: Persona;
  models: { simUser: string; buddy: string; cheap: string };
  started_at: string;
  finished_at?: string;
  done_reason?: string;
  error?: string;
}

export function writeTranscript(
  outDir: string,
  meta: TranscriptMeta,
  turns: TranscriptTurn[],
): { jsonl: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const base = `${meta.scenario}__${meta.run_id}`;
  const jsonlPath = join(outDir, `${base}.jsonl`);
  const mdPath = join(outDir, `${base}.md`);

  const lines: string[] = [
    JSON.stringify({ type: "meta", ...meta }),
    ...turns.map((t) => JSON.stringify({ type: "turn", ...t })),
  ];
  writeFileSync(jsonlPath, lines.join("\n") + "\n");

  const md = [
    `# ${meta.scenario} — ${meta.run_id}`,
    "",
    `**Stress:** ${meta.stress}`,
    `**Persona:** ${meta.persona.name}, ${meta.persona.age}, ${meta.persona.sex}, ` +
      `${meta.persona.weight_kg}kg / ${meta.persona.height_cm}cm, goal=${meta.persona.goal}`,
    `**Style:** ${meta.persona.speaking_style}`,
    `**Diet:** ${meta.persona.diet}`,
    `**Quirks:** ${meta.persona.quirks.join("; ")}`,
    "",
    `Models: sim=${meta.models.simUser}, buddy=${meta.models.buddy}`,
    meta.done_reason ? `Done: ${meta.done_reason}` : "",
    meta.error ? `Error: ${meta.error}` : "",
    "",
    "---",
    "",
    ...turns.flatMap((t) => {
      if (t.from === "user") {
        return [`**USER** (${t.action}): ${t.text ?? JSON.stringify(t.payload)}`, ""];
      }
      return (t.turns ?? []).flatMap((bt) => {
        const chip = bt.entry ? ` \`#${bt.entry.id} ~${bt.entry.kcal}kcal\`` : "";
        return [`**BOT** _${bt.kind}_${chip}: ${bt.text}`, ""];
      });
    }),
  ].filter((x) => x !== undefined);

  writeFileSync(mdPath, md.join("\n"));
  return { jsonl: jsonlPath, md: mdPath };
}

export function newRunId(): string {
  const t = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const r = Math.random().toString(36).slice(2, 7);
  return `${t}_${r}`;
}

export function defaultModels() {
  return {
    simUser: config.modelSimUser,
    buddy: config.modelBuddy,
    cheap: config.modelCheap,
  };
}
