type EventDefinition<TData> = {
  name: string;
  _data?: TData;
};

const definedEvents = new Set<string>();

export function defineEvent<TData>(name: string): EventDefinition<TData> {
  definedEvents.add(name);
  return {
    name,
  };
}

/** The name of every event `defineEvent` has defined in this JS context so far. */
export function definedEventNames(): ReadonlySet<string> {
  return definedEvents;
}

/**
 * Whether `channel` is the IPC channel of one of `eventNames`: the name itself,
 * or the name with a topic (`name.topic`, as `createEventEmitter` builds it).
 */
export function isEventChannel(eventNames: ReadonlySet<string>, channel: string): boolean {
  if (eventNames.has(channel)) return true;
  for (let dot = channel.indexOf('.'); dot > 0; dot = channel.indexOf('.', dot + 1))
    if (eventNames.has(channel.slice(0, dot))) return true;
  return false;
}

export type EmitterAdapter = {
  emit: (eventName: string, data: unknown, topic?: string) => void;
  on: (eventName: string, cb: (data: unknown) => void, topic?: string) => () => void;
};

export function createEventEmitter(adapter: EmitterAdapter) {
  // One adapter listener per channel; all JS subscribers fan out from it.
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const adapterOff = new Map<string, () => void>();

  function getOrAttach(channel: string): Set<(data: unknown) => void> {
    if (!listeners.has(channel)) {
      const set = new Set<(data: unknown) => void>();
      // Attach first: an adapter that refuses the channel throws before the
      // channel is recorded as attached.
      const off = adapter.on(channel, (data) => {
        for (const cb of set) {
          try {
            cb(data);
          } catch {}
        }
      });
      listeners.set(channel, set);
      adapterOff.set(channel, off);
    }
    return listeners.get(channel)!;
  }

  function maybePrune(channel: string): void {
    if (listeners.get(channel)?.size === 0) {
      listeners.delete(channel);
      adapterOff.get(channel)?.();
      adapterOff.delete(channel);
    }
  }

  return {
    emit: <TData>(event: EventDefinition<TData>, data: TData, topic?: string): void => {
      adapter.emit(event.name, data, topic);
    },
    on: <TData>(
      event: EventDefinition<TData>,
      cb: (data: TData) => void,
      topic?: string
    ): (() => void) => {
      const channel = topic ? `${event.name}.${topic}` : event.name;
      const wrapped = (data: unknown) => cb(data as TData);
      getOrAttach(channel).add(wrapped);
      return () => {
        listeners.get(channel)?.delete(wrapped);
        maybePrune(channel);
      };
    },
    once: <TData>(
      event: EventDefinition<TData>,
      cb: (data: TData) => void,
      topic?: string
    ): (() => void) => {
      const channel = topic ? `${event.name}.${topic}` : event.name;
      const set = getOrAttach(channel);
      const unsub = () => {
        set.delete(wrapped);
        maybePrune(channel);
      };
      const wrapped = (data: unknown) => {
        cb(data as TData);
        unsub();
      };
      set.add(wrapped);
      return unsub;
    },
  };
}
