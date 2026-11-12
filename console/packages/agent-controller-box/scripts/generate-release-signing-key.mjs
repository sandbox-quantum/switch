import { generateKeyPairSync } from 'node:crypto';

/**
 * Generates a controller release signing key pair (Ed25519):
 *
 *   node scripts/generate-release-signing-key.mjs <key id>
 *
 * Prints, on stdout, the entry to add to TRUSTED_RELEASE_KEYS in
 * src/release-keys.ts, the matching line for install.sh's TRUSTED RELEASE KEYS
 * block, and the private key as PKCS#8 PEM, which goes into the
 * CONTROLLER_RELEASE_SIGNING_KEY GitHub Actions secret and nowhere else. Run
 * it on a machine you trust and do not keep the private key in a file. See
 * "Release signing" in RELEASING.md.
 */
const id = process.argv[2];
if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
  process.stderr.write(
    'usage: node scripts/generate-release-signing-key.mjs <key id>\n' +
      'The id names the key in the trusted list, e.g. release-2026-10: letters, digits, ".", "_" and "-".\n'
  );
  process.exit(2);
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

process.stdout.write(
  [
    '# 1. Add to TRUSTED_RELEASE_KEYS in src/release-keys.ts:',
    `  { id: '${id}', publicKey: '${spki}' },`,
    '',
    "# 2. Add between install.sh's BEGIN/END TRUSTED RELEASE KEYS lines, inside the quotes:",
    `${id} ${spki}`,
    '',
    '# 3. Store as the CONTROLLER_RELEASE_SIGNING_KEY GitHub Actions secret (then discard):',
    pem.trimEnd(),
    '',
  ].join('\n')
);
