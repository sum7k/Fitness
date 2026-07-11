import { type Context } from "grammy";
import type { User } from "../db/index.js";
import type { OnboardInputPart } from "../llm/onboard.js";
import { beginOnboarding, continueOnboarding } from "../core/onboarding.js";
import { replyTurns } from "./ingest.js";

export async function startOnboarding(ctx: Context, user: User) {
  await replyTurns(ctx, beginOnboarding(user));
}

export async function handleOnboarding(ctx: Context, user: User, parts: OnboardInputPart[]) {
  await replyTurns(ctx, await continueOnboarding(user, parts));
}
