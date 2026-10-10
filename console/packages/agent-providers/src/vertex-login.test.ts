import { describe, expect, it } from 'vitest';
import {
  generateSealingKeyPair,
  openProviderLogin,
  providerLoginSchema,
  sealProviderLogin,
} from './sealed-login';
import { AUTHORIZED_USER_FIXTURE, SERVICE_ACCOUNT_KEY_FIXTURE } from './testing/vertex-fixtures';
import {
  parseGoogleCredentials,
  parseVertexLogin,
  vertexLoginCredential,
  type GoogleCredentials,
} from './vertex-login';

const SERVICE_ACCOUNT_KEY = SERVICE_ACCOUNT_KEY_FIXTURE;
const AUTHORIZED_USER = AUTHORIZED_USER_FIXTURE;

function credential(credentials: unknown, project = 'cg-vertexai', region = 'global'): string {
  return vertexLoginCredential({ project, region, credentials: credentials as GoogleCredentials });
}

describe('Vertex AI logins', () => {
  it('takes a service account key or a user sign-in, keeping their other fields', () => {
    for (const credentials of [SERVICE_ACCOUNT_KEY, AUTHORIZED_USER]) {
      expect(parseVertexLogin(credential(credentials))).toEqual({
        v: 1,
        project: 'cg-vertexai',
        region: 'global',
        credentials,
      });
      expect(parseGoogleCredentials(JSON.stringify(credentials))).toEqual(credentials);
    }
    expect(parseVertexLogin(credential(SERVICE_ACCOUNT_KEY, ' my-project-1 ', 'us-east5'))).toEqual(
      expect.objectContaining({ project: 'my-project-1', region: 'us-east5' })
    );
  });

  it('refuses other Google credential types', () => {
    for (const type of ['external_account', 'impersonated_service_account', undefined])
      expect(() => credential({ type, audience: 'x' })).toThrow(
        /Only a service account key or a Google sign-in/
      );
    expect(() => parseGoogleCredentials('not json')).toThrow(/not JSON/);
    expect(() => parseGoogleCredentials('[]')).toThrow(/not a JSON object/);
  });

  it('says which field of a credential is missing or wrong', () => {
    const { refresh_token: _, ...noRefresh } = AUTHORIZED_USER;
    expect(() => credential(noRefresh)).toThrow(/Google sign-in .*refresh_token/);
    expect(() => credential({ ...SERVICE_ACCOUNT_KEY, private_key: 'nope' })).toThrow(
      /service account key .*private_key/
    );
    expect(() => credential({ ...SERVICE_ACCOUNT_KEY, client_email: 'nope' })).toThrow(
      /client_email/
    );
    expect(() =>
      credential({ ...SERVICE_ACCOUNT_KEY, token_uri: 'http://attacker.example/token' })
    ).toThrow(/token_uri/);
  });

  it('checks the project and region', () => {
    for (const project of ['Upper-Case', 'short', '1starts-with-digit', 'ends-with-hyphen-', ''])
      expect(() => credential(SERVICE_ACCOUNT_KEY, project)).toThrow(/project id/);
    for (const region of ['', 'us east', 'US-EAST5', 'us_east5'])
      expect(() => credential(SERVICE_ACCOUNT_KEY, 'cg-vertexai', region)).toThrow(/region/);
  });

  it('refuses a login that is not one', () => {
    expect(() => parseVertexLogin('{')).toThrow(/not JSON/);
    expect(() =>
      parseVertexLogin(
        JSON.stringify({ v: 2, project: 'cg-vertexai', region: 'global', credentials: {} })
      )
    ).toThrow(/invalid v/);
    expect(() =>
      parseVertexLogin(
        JSON.stringify({
          v: 1,
          project: 'cg-vertexai',
          region: 'global',
          credentials: AUTHORIZED_USER,
          extra: true,
        })
      )
    ).toThrow(/invalid/);
  });

  it('is sealed and opened as a provider login of kind vertex, and checked when it is', () => {
    const keys = generateSealingKeyPair();
    const login = { kind: 'vertex' as const, credential: credential(SERVICE_ACCOUNT_KEY) };
    const sealed = sealProviderLogin({
      publicKey: keys.publicKey,
      controllerId: 'controller-1',
      provider: 'claude',
      login,
    });
    expect(sealed.ciphertext).not.toContain('PRIVATE KEY');
    expect(
      openProviderLogin({ keys, controllerId: 'controller-1', provider: 'claude', sealed })
    ).toEqual(login);
    expect(() =>
      sealProviderLogin({
        publicKey: keys.publicKey,
        controllerId: 'controller-1',
        provider: 'claude',
        login: { kind: 'vertex', credential: '{"v":1}' },
      })
    ).toThrow(/Vertex AI login/);
    expect(
      providerLoginSchema.safeParse({
        kind: 'vertex',
        credential: credential(AUTHORIZED_USER).replace('authorized_user', 'external_account'),
      }).success
    ).toBe(false);
  });
});
