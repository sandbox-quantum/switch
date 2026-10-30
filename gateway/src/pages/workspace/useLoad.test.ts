import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLoad } from "./useLoad";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useLoad", () => {
  it("keeps the latest load's answer when an earlier one lands after it", async () => {
    const answers = [deferred<string>(), deferred<string>(), deferred<string>()];
    let n = 0;
    const load = () => answers[n++].promise;
    const { result } = renderHook(() => useLoad(load));

    await act(async () => answers[0].resolve("first"));
    expect(result.current.data).toBe("first");

    let older!: Promise<void>;
    let newer!: Promise<void>;
    act(() => {
      older = result.current.refetch();
      newer = result.current.refetch();
    });
    await act(async () => {
      answers[2].resolve("newer");
      await newer;
    });
    await act(async () => {
      answers[1].resolve("older");
      await older;
    });

    expect(result.current.data).toBe("newer");
  });
});
