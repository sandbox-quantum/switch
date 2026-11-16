import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLoad } from "./useLoad";

describe("useLoad", () => {
  it("keeps the latest load when an older one answers after it", async () => {
    const pending: ((value: string) => void)[] = [];
    const load = () => new Promise<string>((resolve) => pending.push(resolve));
    const { result } = renderHook(() => useLoad(load));

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refetch();
    });
    await act(async () => {
      pending[1]("newer");
      await refresh;
    });
    await act(async () => {
      pending[0]("older");
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe("newer");
  });

  it("keeps what it had, with the reason, when a refresh fails", async () => {
    let fail = false;
    const load = async () => {
      if (fail) throw new Error("The database is unavailable.");
      return "first";
    };
    const { result } = renderHook(() => useLoad(load));
    await waitFor(() => expect(result.current.data).toBe("first"));

    fail = true;
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.data).toBe("first");
    expect(result.current.error).toBe("The database is unavailable.");
  });
});
