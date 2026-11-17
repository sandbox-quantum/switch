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
 * The PATH is read and written in the registry as it is stored, unexpanded and
 * as `REG_EXPAND_SZ`: `[Environment]::GetEnvironmentVariable` expands entries
 * such as `%USERPROFILE%\…` and `SetEnvironmentVariable` writes them back as
 * plain text, which would pin them to the profile's current location. Setting
 * and clearing a placeholder variable afterwards is what announces the change,
 * so terminals opened from Explorer see it.
 *
 * Written without `$`, `%` or double quotes, so the install runner's shell,
 * cmd.exe or PowerShell, passes it through untouched.
 */
export function addToUserPath(...segments: string[]): string {
  const folder = `[IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'), ${segments
    .map((segment) => `'${segment}'`)
    .join(', ')})`;
  const userPath = `([string][Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames'))`;
  const entries = `[Environment]::ExpandEnvironmentVariables(${userPath}).ToLower().Split(';').TrimEnd('\\')`;
  return (
    `if (-not (${entries} -contains ${folder}.ToLower())) { ` +
    `[Microsoft.Win32.Registry]::SetValue('HKEY_CURRENT_USER\\Environment', 'Path', (${userPath}.TrimEnd(';') + ';' + ${folder}).TrimStart(';'), 'ExpandString'); ` +
    `[Environment]::SetEnvironmentVariable('SwitchConsolePathChanged', '1', 'User'); ` +
    `[Environment]::SetEnvironmentVariable('SwitchConsolePathChanged', '', 'User') }`
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
