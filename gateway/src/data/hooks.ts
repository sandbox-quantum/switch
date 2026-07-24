import { useCallback, useEffect, useState } from "react";
import {
  type AgentDetail,
  type AgentSummary,
  type ApiKeyDetail,
  type BridgeDetail,
  type BridgeTypeInfo,
  type ExternalUserSummary,
  type ConnectorTypeInfo,
  type DocumentDetail,
  type DocumentSummary,
  type InboundLinkedRoomDetail,
  type KnownAgentType,
  type LinkedRoomDetail,
  type RoomGraphData,
  type EcosystemGraphData,
  type PackageDetail,
  type ReferenceDetail,
  type ReferenceTypeInfo,
  type ResourceRoom,
  type RoomDetail,
  type RoomGroupDetail,
  type RoomSummary,
  type UserInfo,
  fetchAgent,
  fetchAgents,
  fetchApiKeys,
  fetchAllExternalUsers,
  fetchBridges,
  fetchBridgeTypes,
  fetchBridgeUsers,
  fetchConnectorTypes,
  fetchDocumentRooms,
  fetchDocuments,
  fetchInboundLinkedRooms,
  fetchKnownAgentTypes,
  fetchLinkedRooms,
  fetchRoomGraph,
  fetchEcosystemGraph,
  fetchPackage,
  fetchPackageDocuments,
  fetchPackageReferences,
  fetchPackageRooms,
  fetchPackages,
  fetchReferenceRooms,
  fetchReferenceTypes,
  fetchReferences,
  fetchRoom,
  fetchRoomGroups,
  fetchRoomDocument,
  fetchRoomDocuments,
  fetchRoomPackages,
  fetchRoomReferences,
  fetchRooms,
  fetchUsers,
} from "./api";

export interface UseQueryResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function useQuery<T>(fetcher: () => Promise<T | null>): UseQueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetcher().then((result) => {
      if (cancelled) return;
      if (result === null) {
        setError("Failed to fetch data");
      } else {
        setData(result);
        setError(null);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [fetcher, tick]);

  return { data, loading, error, refetch };
}

export function useRooms(
  search?: string,
  includeArchived?: boolean,
): UseQueryResult<RoomSummary[]> {
  const fetcher = useCallback(
    () => fetchRooms(search, includeArchived),
    [search, includeArchived],
  );
  return useQuery(fetcher);
}

export function useRoom(roomId: string | undefined): UseQueryResult<RoomDetail> {
  const fetcher = useCallback(
    () => (roomId ? fetchRoom(roomId) : Promise.resolve(null)),
    [roomId],
  );
  return useQuery(fetcher);
}

export function useAgents(): UseQueryResult<AgentSummary[]> {
  return useQuery(fetchAgents);
}

export function useAgent(
  agentId: string | undefined,
): UseQueryResult<AgentDetail> {
  const fetcher = useCallback(
    () => (agentId ? fetchAgent(agentId) : Promise.resolve(null)),
    [agentId],
  );
  return useQuery(fetcher);
}

export function useRoomGroups(): UseQueryResult<RoomGroupDetail[]> {
  return useQuery(fetchRoomGroups);
}

export function useBridges(): UseQueryResult<BridgeDetail[]> {
  return useQuery(fetchBridges);
}
export function useBridgeTypes(): UseQueryResult<BridgeTypeInfo[]> {
  return useQuery(fetchBridgeTypes);
}

export function useBridgeUsers(
  bridgeId: string | undefined,
): UseQueryResult<ExternalUserSummary[]> {
  const fetcher = useCallback(
    () => (bridgeId ? fetchBridgeUsers(bridgeId) : Promise.resolve(null)),
    [bridgeId],
  );
  return useQuery(fetcher);
}

export function useAllExternalUsers(): UseQueryResult<ExternalUserSummary[]> {
  return useQuery(fetchAllExternalUsers);
}

export function useKnownAgentTypes(): UseQueryResult<KnownAgentType[]> {
  return useQuery(fetchKnownAgentTypes);
}

export function useUsers(): UseQueryResult<UserInfo[]> {
  return useQuery(fetchUsers);
}

export function useConnectorTypes(): UseQueryResult<ConnectorTypeInfo[]> {
  return useQuery(fetchConnectorTypes);
}

export function useApiKeys(): UseQueryResult<ApiKeyDetail[]> {
  return useQuery(fetchApiKeys);
}

export function useReferences(): UseQueryResult<ReferenceDetail[]> {
  return useQuery(fetchReferences);
}

export function useDocuments(): UseQueryResult<DocumentSummary[]> {
  return useQuery(fetchDocuments);
}

export function useReferenceTypes(): UseQueryResult<ReferenceTypeInfo[]> {
  return useQuery(fetchReferenceTypes);
}

export function useLinkedRooms(
  roomId: string | undefined,
): UseQueryResult<LinkedRoomDetail[]> {
  const fetcher = useCallback(
    () => (roomId ? fetchLinkedRooms(roomId) : Promise.resolve(null)),
    [roomId],
  );
  return useQuery(fetcher);
}

export function useInboundLinkedRooms(
  roomId: string | undefined,
): UseQueryResult<InboundLinkedRoomDetail[]> {
  const fetcher = useCallback(
    () => (roomId ? fetchInboundLinkedRooms(roomId) : Promise.resolve(null)),
    [roomId],
  );
  return useQuery(fetcher);
}

export function useRoomGraph(): UseQueryResult<RoomGraphData> {
  return useQuery(fetchRoomGraph);
}

export function useEcosystemGraph(): UseQueryResult<EcosystemGraphData> {
  return useQuery(fetchEcosystemGraph);
}

export function useRoomReferences(
  roomId: string | undefined,
): UseQueryResult<ReferenceDetail[]> {
  const fetcher = useCallback(
    () => (roomId ? fetchRoomReferences(roomId) : Promise.resolve(null)),
    [roomId],
  );
  return useQuery(fetcher);
}

export function useRoomDocuments(
  roomId: string | undefined,
): UseQueryResult<DocumentSummary[]> {
  const fetcher = useCallback(
    () => (roomId ? fetchRoomDocuments(roomId) : Promise.resolve(null)),
    [roomId],
  );
  return useQuery(fetcher);
}

export function useRoomDocument(
  roomId: string | undefined,
  documentId: string | undefined,
): UseQueryResult<DocumentDetail> {
  const fetcher = useCallback(
    () =>
      roomId && documentId
        ? fetchRoomDocument(roomId, documentId)
        : Promise.resolve(null),
    [roomId, documentId],
  );
  return useQuery(fetcher);
}

export function useReferenceRooms(
  referenceId: string | undefined,
): UseQueryResult<ResourceRoom[]> {
  const fetcher = useCallback(
    () => (referenceId ? fetchReferenceRooms(referenceId) : Promise.resolve(null)),
    [referenceId],
  );
  return useQuery(fetcher);
}

export function useDocumentRooms(
  documentId: string | undefined,
): UseQueryResult<ResourceRoom[]> {
  const fetcher = useCallback(
    () => (documentId ? fetchDocumentRooms(documentId) : Promise.resolve(null)),
    [documentId],
  );
  return useQuery(fetcher);
}

export function usePackages(): UseQueryResult<PackageDetail[]> {
  return useQuery(fetchPackages);
}

export function usePackage(
  packageId: string | undefined,
): UseQueryResult<PackageDetail> {
  const fetcher = useCallback(
    () => (packageId ? fetchPackage(packageId) : Promise.resolve(null)),
    [packageId],
  );
  return useQuery(fetcher);
}

export function useRoomPackages(
  roomId: string | undefined,
): UseQueryResult<PackageDetail[]> {
  const fetcher = useCallback(
    () => (roomId ? fetchRoomPackages(roomId) : Promise.resolve(null)),
    [roomId],
  );
  return useQuery(fetcher);
}

export function usePackageRooms(
  packageId: string | undefined,
): UseQueryResult<ResourceRoom[]> {
  const fetcher = useCallback(
    () => (packageId ? fetchPackageRooms(packageId) : Promise.resolve(null)),
    [packageId],
  );
  return useQuery(fetcher);
}

export function usePackageReferences(
  packageId: string | undefined,
): UseQueryResult<ReferenceDetail[]> {
  const fetcher = useCallback(
    () => (packageId ? fetchPackageReferences(packageId) : Promise.resolve(null)),
    [packageId],
  );
  return useQuery(fetcher);
}

export function usePackageDocuments(
  packageId: string | undefined,
): UseQueryResult<DocumentSummary[]> {
  const fetcher = useCallback(
    () => (packageId ? fetchPackageDocuments(packageId) : Promise.resolve(null)),
    [packageId],
  );
  return useQuery(fetcher);
}
