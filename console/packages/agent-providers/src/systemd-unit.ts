/**
 * Writing values into a systemd unit file. systemd expands `%` specifiers in
 * nearly every setting and `$VAR` in command lines, ends a setting at a
 * newline and joins the next line onto a trailing backslash, so a value
 * written as is can change what the unit runs. Each helper refuses control
 * characters and escapes the rest for the place it is written.
 */

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function refuseControlCharacters(value: string): void {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(
      `Cannot write a value with control characters into a systemd unit: ${JSON.stringify(value)}`
    );
  }
}

function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&').replace(/%/g, '%%')}"`;
}

/** One argument of an `ExecStart=` (or other `Exec*=`) command line, quoted. */
export function systemdExecArgument(value: string): string {
  refuseControlCharacters(value);
  return quoted(value).replace(/\$/g, '$$$$');
}

/** An `ExecStart=` command line: every argument quoted, none expanded. */
export function systemdExecCommand(args: string[]): string {
  return args.map(systemdExecArgument).join(' ');
}

/** The value of an `Environment=` assignment (`NAME=value`), quoted. */
export function systemdEnvironment(assignment: string): string {
  refuseControlCharacters(assignment);
  return quoted(assignment);
}

/** A free-text value such as `Description=`, written unquoted. */
export function systemdText(value: string): string {
  refuseControlCharacters(value);
  if (value.endsWith('\\')) {
    throw new Error(
      `Cannot write a value ending in a backslash into a systemd unit: ${JSON.stringify(value)}`
    );
  }
  return value.replace(/%/g, '%%');
}
