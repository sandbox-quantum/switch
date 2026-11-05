export function scheduleTime(value: string, timezone: string): string {
  const date = new Date(value);
  try {
    return `${date.toLocaleString(undefined, { timeZone: timezone })} (${timezone})`;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return `${date.toLocaleString(undefined, { timeZone: 'UTC' })} (UTC; scheduled in ${timezone})`;
  }
}
