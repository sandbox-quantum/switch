import { createContext, useContext } from "react";
import type { ConnectorAppScope } from "../../data/api";

/** Whose apps the cards under it change: the server's, unless an
 * organization's page says otherwise. */
export const ConnectorAppScopeContext = createContext<ConnectorAppScope>("server");

export function useConnectorAppScope(): ConnectorAppScope {
  return useContext(ConnectorAppScopeContext);
}
