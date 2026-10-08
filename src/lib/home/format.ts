/** Formats whole seconds as HH:MM:SS (negative and fractional input are clamped/floored). */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, "0")).join(":");
}

/** `MM:SS` (minutes may exceed 59 after buying time). Clamped at zero and floored. */
export function formatMinSec(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A duration in words for running text: `14400` → "4 hours", `5400` → "1 hour 30 minutes", `90` → "1 minute 30 seconds".
 * Zero parts are omitted. Used where the length of the competition is stated, so the wording follows the data.
 */
export function describeDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const parts: string[] = [];
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) parts.push(unit(h, "hour"));
  if (m) parts.push(unit(m, "minute"));
  if (sec || parts.length === 0) parts.push(unit(sec, "second"));
  return parts.join(" ");
}

/** A Buy Time pack label: whole minutes when it divides evenly ("2 mins"), seconds otherwise ("90 secs"). */
export function packLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s % 60 === 0 ? `${s / 60} min${s === 60 ? "" : "s"}` : `${s} secs`;
}
