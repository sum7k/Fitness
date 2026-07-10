const LEVELS = { debug: 0, info: 1, error: 2 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "debug"] ?? LEVELS.debug;

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function emit(level: Level, args: unknown[]) {
  if (LEVELS[level] < threshold) return;
  const line = `[${timestamp()}] ${level.toUpperCase().padEnd(5)}`;
  if (level === "error") console.error(line, ...args);
  else console.log(line, ...args);
}

export const debug = (...args: unknown[]) => emit("debug", args);
export const info = (...args: unknown[]) => emit("info", args);
export const error = (...args: unknown[]) => emit("error", args);
