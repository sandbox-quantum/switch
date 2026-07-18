import { describe, expect, it, vi } from 'vitest';
import type { LocationRuntime } from './location-runtime';
import { LocationRuntimeRegistry } from './location-runtime-registry';

function makeRuntime(id: string): {
  runtime: LocationRuntime;
  dispose: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn(async () => {});

  return {
    runtime: {
      id,
      path: `/tmp/${id}`,
      fs: {} as LocationRuntime['fs'],
      settings: {} as LocationRuntime['settings'],
      lifecycleService: {
        dispose,
      } as unknown as LocationRuntime['lifecycleService'],
    },
    dispose,
  };
}

describe('LocationRuntimeRegistry', () => {
  it('creates once and increments ref count on repeated acquire', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    const factory = vi.fn(async () => ({ runtime }));

    const first = await registry.acquire('loc-a', factory);
    const second = await registry.acquire('loc-a', factory);

    expect(first).toBe(runtime);
    expect(second).toBe(runtime);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.get('loc-a')).toBe(runtime);
    expect(registry.refCount('loc-a')).toBe(2);
  });

  it('coalesces concurrent acquires for the same key', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    let resolveFactory: ((value: { runtime: LocationRuntime }) => void) | undefined;
    const factory = vi.fn(
      () =>
        new Promise<{ runtime: LocationRuntime }>((resolve) => {
          resolveFactory = resolve;
        })
    );

    const first = registry.acquire('loc-a', factory);
    const second = registry.acquire('loc-a', factory);

    expect(factory).toHaveBeenCalledTimes(1);
    resolveFactory?.({ runtime });

    await expect(first).resolves.toBe(runtime);
    await expect(second).resolves.toBe(runtime);
    expect(registry.refCount('loc-a')).toBe(2);
  });

  it('disposes runtime resources when ref count reaches zero', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime, dispose } = makeRuntime('loc-a');
    const factory = vi.fn(async () => ({ runtime }));

    await registry.acquire('loc-a', factory);
    await registry.acquire('loc-a', factory);

    await registry.release('loc-a');
    expect(dispose).not.toHaveBeenCalled();
    expect(registry.refCount('loc-a')).toBe(1);

    await registry.release('loc-a');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.get('loc-a')).toBeUndefined();
    expect(registry.refCount('loc-a')).toBe(0);
  });

  it('disposeAll disposes each runtime once and clears the registry', async () => {
    const registry = new LocationRuntimeRegistry();
    const first = makeRuntime('loc-a');
    const second = makeRuntime('loc-b');

    await registry.acquire('loc-a', async () => ({ runtime: first.runtime }));
    await registry.acquire('loc-a', async () => ({ runtime: first.runtime }));
    await registry.acquire('loc-b', async () => ({ runtime: second.runtime }));

    await registry.disposeAll();

    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(registry.refCount('loc-a')).toBe(0);
    expect(registry.refCount('loc-b')).toBe(0);
  });

  it('ignores release for unknown keys', async () => {
    const registry = new LocationRuntimeRegistry();
    await expect(registry.release('missing')).resolves.toBeUndefined();
  });

  it('calls onCreateSideEffect once on first acquire and not on re-acquire', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    const onCreateSideEffect = vi.fn();
    const factory = vi.fn(async () => ({ runtime, onCreateSideEffect }));

    await registry.acquire('loc-a', factory);
    expect(onCreateSideEffect).toHaveBeenCalledTimes(1);
    expect(onCreateSideEffect).toHaveBeenCalledWith(runtime);

    await registry.acquire('loc-a', factory);
    expect(onCreateSideEffect).toHaveBeenCalledTimes(1);
  });

  it('awaits onCreate before acquire resolves', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    const order: string[] = [];

    const onCreate = vi.fn(async () => {
      order.push('onCreate');
    });
    const factory = vi.fn(async () => ({ runtime, onCreate }));

    const acquired = registry.acquire('loc-a', factory).then((rt) => {
      order.push('acquired');
      return rt;
    });

    await acquired;

    expect(order).toEqual(['onCreate', 'acquired']);
    expect(onCreate).toHaveBeenCalledWith(runtime);
  });

  it('does not call onCreate on re-acquire', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    const onCreate = vi.fn(async () => {});
    const factory = vi.fn(async () => ({ runtime, onCreate }));

    await registry.acquire('loc-a', factory);
    await registry.acquire('loc-a', factory);

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('calls onDestroy once at final release, not on earlier releases', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    const onDestroy = vi.fn(async () => {});
    const factory = vi.fn(async () => ({ runtime, onDestroy }));

    await registry.acquire('loc-a', factory);
    await registry.acquire('loc-a', factory);

    await registry.release('loc-a');
    expect(onDestroy).not.toHaveBeenCalled();

    await registry.release('loc-a');
    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(onDestroy).toHaveBeenCalledWith(runtime);
  });

  it('calls onDestroy before lifecycleService.dispose', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime, dispose } = makeRuntime('loc-a');
    const order: string[] = [];

    dispose.mockImplementation(() => {
      order.push('lifecycleDispose');
      return undefined;
    });

    const onDestroy = vi.fn(() => {
      order.push('onDestroy');
      return Promise.resolve();
    });
    const factory = vi.fn(async () => ({ runtime, onDestroy }));

    await registry.acquire('loc-a', factory);
    await registry.release('loc-a');

    expect(order).toEqual(['onDestroy', 'lifecycleDispose']);
  });

  it('calls onDestroy for each entry in disposeAll', async () => {
    const registry = new LocationRuntimeRegistry();
    const first = makeRuntime('loc-a');
    const second = makeRuntime('loc-b');
    const onDestroyFirst = vi.fn(async () => {});
    const onDestroySecond = vi.fn(async () => {});

    await registry.acquire('loc-a', async () => ({
      runtime: first.runtime,
      onDestroy: onDestroyFirst,
    }));
    await registry.acquire('loc-b', async () => ({
      runtime: second.runtime,
      onDestroy: onDestroySecond,
    }));

    await registry.disposeAll();

    expect(onDestroyFirst).toHaveBeenCalledTimes(1);
    expect(onDestroyFirst).toHaveBeenCalledWith(first.runtime);
    expect(onDestroySecond).toHaveBeenCalledTimes(1);
    expect(onDestroySecond).toHaveBeenCalledWith(second.runtime);
  });

  it('calls onDetach (not onDestroy) when releasing with detach mode', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    const onDestroy = vi.fn(async () => {});
    const onDetach = vi.fn(async () => {});
    const factory = vi.fn(async () => ({ runtime, onDestroy, onDetach }));

    await registry.acquire('loc-a', factory);
    await registry.release('loc-a', 'detach');

    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDetach).toHaveBeenCalledWith(runtime);
    expect(onDestroy).not.toHaveBeenCalled();
  });

  it('calls onDestroy (not onDetach) when releasing with terminate mode', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    const onDestroy = vi.fn(async () => {});
    const onDetach = vi.fn(async () => {});
    const factory = vi.fn(async () => ({ runtime, onDestroy, onDetach }));

    await registry.acquire('loc-a', factory);
    await registry.release('loc-a', 'terminate');

    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(onDestroy).toHaveBeenCalledWith(runtime);
    expect(onDetach).not.toHaveBeenCalled();
  });

  it('does not call onDetach when ref count has not reached zero', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    const onDetach = vi.fn(async () => {});
    const factory = vi.fn(async () => ({ runtime, onDetach }));

    await registry.acquire('loc-a', factory);
    await registry.acquire('loc-a', factory);

    await registry.release('loc-a', 'detach');
    expect(onDetach).not.toHaveBeenCalled();

    await registry.release('loc-a', 'detach');
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it('releaseAll forces teardown regardless of ref count', async () => {
    const registry = new LocationRuntimeRegistry();
    const { runtime } = makeRuntime('loc-a');
    const onDestroy = vi.fn(async () => {});
    const onDetach = vi.fn(async () => {});

    await registry.acquire('loc-a', async () => ({ runtime, onDestroy, onDetach }));
    await registry.acquire('loc-a', async () => ({ runtime, onDestroy, onDetach }));

    await registry.releaseAll('loc-a', 'detach');

    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDestroy).not.toHaveBeenCalled();
    expect(registry.refCount('loc-a')).toBe(0);
  });
});
