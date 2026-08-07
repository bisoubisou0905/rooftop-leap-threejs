const DEFAULT_ROOM = "quick-0905";

export function normalizeDuelRoom(value: string | null | undefined) {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 24);
  return normalized || DEFAULT_ROOM;
}

export function makeDuelMatchId(first: string, second: string) {
  return [first, second].sort().join("-");
}
