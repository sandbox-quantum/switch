/**
 * Whether the usage-data notice is still owed: never shown, or not read yet.
 * The first-run pages show it to a new install; an install that already held
 * servers when it updated to a build with those pages never saw them, and is
 * shown this prompt over its workspace instead.
 */
export function usageNoticeOwed(telemetry: { askedAt: number | null } | undefined): boolean {
  return telemetry === undefined || telemetry.askedAt === null;
}
