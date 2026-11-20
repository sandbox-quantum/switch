import { describe, expect, it } from 'vitest';
import { vertexLoginCredential } from './vertex-login';

const key = JSON.stringify({
  type: 'service_account',
  client_email: 'claude@my-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
});

describe('vertexLoginCredential', () => {
  it('carries the project, region and Google credential as the machine reads them', () => {
    expect(
      JSON.parse(
        vertexLoginCredential({ project: ' my-project ', region: 'global', googleCredentials: key })
      )
    ).toEqual({ v: 1, project: 'my-project', region: 'global', credentials: JSON.parse(key) });
  });

  it('says what is wrong before anything is sealed', () => {
    expect(() =>
      vertexLoginCredential({ project: 'X', region: 'global', googleCredentials: key })
    ).toThrow('not a Google Cloud project id');
    expect(() =>
      vertexLoginCredential({ project: 'my-project', region: 'global', googleCredentials: '{' })
    ).toThrow('not JSON');
    expect(() =>
      vertexLoginCredential({
        project: 'my-project',
        region: 'global',
        googleCredentials: JSON.stringify({ type: 'external_account' }),
      })
    ).toThrow('Only a service account key');
    expect(() =>
      vertexLoginCredential({
        project: 'my-project',
        region: 'global',
        googleCredentials: JSON.stringify({ type: 'authorized_user', client_id: 'a' }),
      })
    ).toThrow('missing client_secret, refresh_token');
  });
});
