/**
 * PowerShell, for inside a `powershell -c "…"` install command, that adds
 * `~\<segments>` to the user's PATH unless it is already there.
 *
 * Some installers put their CLI in a folder they never add to PATH (Claude
 * Code's in `~\.local\bin`), and a release unpacked by hand has no installer
 * to do it. Switch Console finds the folder either way; this is for the
 * person, whose new terminals then find the CLI too, as the sign-in and
 * manual steps tell them to run it there.
 *
 * Written without `$`, `%` or double quotes, so the install runner's shell,
 * cmd.exe or PowerShell, passes it through untouched.
 */
export function addToUserPath(...segments: string[]): string {
  const folder = `[IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), ${segments
    .map((segment) => `'${segment}'`)
    .join(', ')})`;
  const userPath = `([string][Environment]::GetEnvironmentVariable('Path', 'User'))`;
  return (
    `if (-not (${userPath}.ToLower().Split(';') -contains ${folder}.ToLower())) { ` +
    `[Environment]::SetEnvironmentVariable('Path', (${userPath}.TrimEnd(';') + ';' + ${folder}).TrimStart(';'), 'User') }`
  );
}

/**
 * PowerShell, for inside a `powershell -c "…"` uninstall command, that deletes
 * `~\<segments>` when it is there. A delete that fails stops the command with
 * PowerShell's own error, so Switch Console reports why; only a path already
 * gone is passed over. Written without `$`, `%` or double quotes, like
 * `addToUserPath`.
 */
export function removeFromProfile(...segments: string[]): string {
  const target = `([IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), ${segments
    .map((segment) => `'${segment}'`)
    .join(', ')}))`;
  return `if (Test-Path -LiteralPath ${target}) { Remove-Item -LiteralPath ${target} -Recurse -Force -ErrorAction Stop }`;
}
