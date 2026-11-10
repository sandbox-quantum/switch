import { afterEach, expect, it, vi } from "vitest";
import { dismissOwnerNotice, fetchOwnerNotices } from "./ownerNotices";

afterEach(() => vi.unstubAllGlobals());

it("uses authenticated requests and encodes notice IDs", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response("[]", { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(fetchOwnerNotices()).resolves.toEqual([]);
  await dismissOwnerNotice("id/with slash");
  expect(fetchMock).toHaveBeenNthCalledWith(1, "/gateway/owner-notices", {
    credentials: "include",
    signal: undefined,
  });
  expect(fetchMock).toHaveBeenNthCalledWith(2, "/gateway/owner-notices/id%2Fwith%20slash", {
    credentials: "include",
    method: "DELETE",
  });
});
