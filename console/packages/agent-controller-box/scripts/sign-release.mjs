import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { TRUSTED_RELEASE_KEYS } from '../src/release-keys.ts';

/**
 * Signs a packaged controller release:
 *
 *   CONTROLLER_RELEASE_SIGNING_KEY=<PKCS#8 PEM> node scripts/sign-release.mjs <package .tgz> <version>
 *
 * Writes `<package>.sig`: the Ed25519 signature, base64 on one line, of
 *
 *   switch-agent-controller-release-v1\n<version>\n<sha256 of the package>\n
 *
 * which the controller (src/release-signing.ts) and install.sh check before
 * they install a release. Fails when the key is missing, is not Ed25519, or
 * its public key is not in src/release-keys.ts: a release no controller trusts
 * is not worth publishing.
 */
const [file, version] = process.argv.slice(2);
if (!file || !version) {
  process.stderr.write('usage: node scripts/sign-release.mjs <package .tgz> <version>\n');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version))
  throw new Error(`The version must be x.y.z or x.y.z-<prerelease>, not '${version}'.`);
const pem = process.env.CONTROLLER_RELEASE_SIGNING_KEY;
if (!pem?.trim())
  throw new Error(
    'CONTROLLER_RELEASE_SIGNING_KEY is not set: a published controller release must be signed. See "Release signing" in RELEASING.md.'
  );
const privateKey = createPrivateKey(pem);
if (privateKey.asymmetricKeyType !== 'ed25519')
  throw new Error('CONTROLLER_RELEASE_SIGNING_KEY must be an Ed25519 private key (PKCS#8 PEM).');
const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');

const key = TRUSTED_RELEASE_KEYS.find((candidate) => candidate.publicKey === spki);
if (!key)
  throw new Error(
    `The signing key's public key (${spki}) is not in src/release-keys.ts, so no controller would install this release. Add it there (and to install.sh) first.`
  );

const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
const message = Buffer.from(`switch-agent-controller-release-v1\n${version}\n${sha256}\n`, 'utf8');
const signature = sign(null, message, privateKey);
if (!verify(null, message, createPublicKey(privateKey), signature))
  throw new Error('The signature just made does not verify.');
writeFileSync(`${file}.sig`, `${signature.toString('base64')}\n`);
process.stdout.write(
  `Signed switch-agent-controller ${version} (SHA-256 ${sha256}) with release key ${key.id}: ${file}.sig\n`
);
