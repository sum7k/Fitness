/** What the user would see in Telegram — collected instead of ctx.reply. */

export interface EntryChip {
  id: number;
  kind: string;
  name: string;
  kcal: number;
  confidence: string | null;
}

export type TurnKind =
  | "onboarding"
  | "entry"
  | "tally"
  | "weight"
  | "buddy"
  | "command"
  | "system"
  | "error";

export interface BotTurn {
  text: string;
  kind: TurnKind;
  /** Present when this turn is an entry line with kcal-correction chips. */
  entry?: EntryChip;
}
