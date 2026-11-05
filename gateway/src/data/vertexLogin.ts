/**
 * A Claude login through Google Vertex AI, built in the browser from a
 * service-account key file, for `sealLogin` (Switch web, hosted agents v2).
 * The same credential Console makes (`vertex-login.ts`):
 * `{"v":1,"project":...,"region":...,"credentials":{...}}`.
 *
 * Only a service account key is taken here. A Google sign-in
 * (`authorized_user`) holds a refresh token and has no place in a browser
 * (security), and every other credential type is refused as in Console.
 * Messages are fixed words, never any part of the file.
 */

export const VERTEX_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const VERTEX_REGION_PATTERN = /^[a-z0-9-]{1,64}$/;
/** A key file is a few kilobytes; anything far larger isn't one. */
export const KEY_FILE_MAX_BYTES = 64 * 1024;

export class VertexKeyRefused extends Error {
  constructor(
    readonly code:
      | "too_large"
      | "not_json"
      | "not_service_account"
      | "missing_fields"
      | "bad_project"
      | "bad_region",
  ) {
    super(
      {
        too_large: "That file is too large to be a service account key.",
        not_json: "That file isn't a service account key (it isn't JSON).",
        not_service_account:
          "That file isn't a service account key. In Switch web, only a service account key file can be given; use Switch Console for a Google sign-in.",
        missing_fields: "That service account key is missing its email or private key.",
        bad_project:
          "That isn't a Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, starting with a letter.",
        bad_region: "That isn't a Vertex AI region, such as global or us-east5.",
      }[code],
    );
    this.name = "VertexKeyRefused";
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The `vertex` credential for a key file's bytes and a project and region.
 * The bytes are zero-filled before this returns, whatever happens.
 */
export function vertexCredential(file: Uint8Array, project: string, region: string): string {
  try {
    if (file.length > KEY_FILE_MAX_BYTES) throw new VertexKeyRefused("too_large");
    const wantedProject = project.trim();
    const wantedRegion = region.trim();
    if (!VERTEX_PROJECT_PATTERN.test(wantedProject)) throw new VertexKeyRefused("bad_project");
    if (!VERTEX_REGION_PATTERN.test(wantedRegion)) throw new VertexKeyRefused("bad_region");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file));
    } catch {
      throw new VertexKeyRefused("not_json");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new VertexKeyRefused("not_json");
    const key = value as Record<string, unknown>;
    if (key.type !== "service_account") throw new VertexKeyRefused("not_service_account");
    const ok =
      typeof key.client_email === "string" &&
      EMAIL.test(key.client_email) &&
      typeof key.private_key === "string" &&
      key.private_key.includes("PRIVATE KEY") &&
      (key.private_key_id === undefined ||
        (typeof key.private_key_id === "string" && key.private_key_id.trim().length > 0)) &&
      (key.token_uri === undefined ||
        (typeof key.token_uri === "string" && key.token_uri.startsWith("https://")));
    if (!ok) throw new VertexKeyRefused("missing_fields");
    return JSON.stringify({ v: 1, project: wantedProject, region: wantedRegion, credentials: key });
  } finally {
    file.fill(0);
  }
}
