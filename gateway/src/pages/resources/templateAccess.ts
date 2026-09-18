import type { AccessLevel } from "../../data/visibility";

/** The access levels as they apply to a template: it is used, not attached. */
export const TEMPLATE_ACCESS_HELPERS: Record<AccessLevel, string> = {
  private: "Only you and admins can see it.",
  read_only: "Everyone on the workspace can use it; only you and admins can change it.",
  public: "Everyone on the workspace can use it and change it.",
};
