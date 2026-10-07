import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { fromInstanceMetadata } from '@aws-sdk/credential-providers';

/** Unwraps a data key KMS issued under `context`; any refusal is thrown. */
export type KmsDecrypt = (input: {
  keyArn: string;
  ciphertext: Uint8Array;
  context: Record<string, string>;
  grantTokens: string[];
}) => Promise<Uint8Array>;

/** KMS in `region` as this instance's role, or at `endpoint` when a test names one. */
export function kmsDecrypter(input: { region: string; endpoint: string | undefined }): KmsDecrypt {
  const client = new KMSClient({
    region: input.region,
    credentials: fromInstanceMetadata(),
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
  });
  return async ({ keyArn, ciphertext, context, grantTokens }) => {
    const result = await client.send(
      new DecryptCommand({
        KeyId: keyArn,
        CiphertextBlob: ciphertext,
        EncryptionContext: context,
        ...(grantTokens.length > 0 ? { GrantTokens: grantTokens } : {}),
      })
    );
    if (!result.Plaintext) throw new Error('KMS returned no plaintext for the login data key.');
    return result.Plaintext;
  };
}
