// Read/write visibility for owned entities (References, Documents, Packages,
// Rooms). The backend stores two independent axes — `read_visibility` and
// `write_visibility`, each "public" | "private" — but the only valid
// combinations collapse to three access levels. Modelling them as a single
// level in the UI prevents the invalid "writable but unreadable" state by
// construction (the backend rejects read=private + write=public).

export type Visibility = "public" | "private";
export type AccessLevel = "private" | "read_only" | "public";

export interface VisibilityPair {
  read_visibility: Visibility;
  write_visibility: Visibility;
}

export function toAccessLevel(pair: VisibilityPair): AccessLevel {
  if (pair.read_visibility !== "public") return "private";
  return pair.write_visibility === "public" ? "public" : "read_only";
}

export function fromAccessLevel(level: AccessLevel): VisibilityPair {
  switch (level) {
    case "public":
      return { read_visibility: "public", write_visibility: "public" };
    case "read_only":
      return { read_visibility: "public", write_visibility: "private" };
    case "private":
      return { read_visibility: "private", write_visibility: "private" };
  }
}

export interface AccessLevelMeta {
  label: string; // compact chip label
  optionLabel: string; // dropdown option label
  helper: string; // form helper text
  /** Access level is a setting, not a status — nothing here succeeded or
   * failed, so the chips stay neutral and the label carries the meaning. */
  color: "default";
}

export const ACCESS_LEVELS: AccessLevel[] = ["private", "read_only", "public"];

export const ACCESS_META: Record<AccessLevel, AccessLevelMeta> = {
  private: {
    label: "Private",
    optionLabel: "Private (only me)",
    helper: "Only you and admins can see or change it.",
    color: "default",
  },
  read_only: {
    label: "Read-only",
    optionLabel: "Public — read only",
    helper: "Anyone can see and attach it; only you and admins can change it.",
    color: "default",
  },
  public: {
    label: "Public",
    optionLabel: "Public — read & write",
    helper: "Anyone can see, attach, and change it.",
    color: "default",
  },
};
