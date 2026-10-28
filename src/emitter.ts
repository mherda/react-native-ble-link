type Listener<T extends unknown[]> = (...args: T) => void;

/** Minimal typed event emitter. */
export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly listeners: {
    [K in keyof Events]?: Set<Listener<Events[K]>>;
  } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = (this.listeners[event] ??= new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  protected fire<K extends keyof Events>(event: K, ...args: Events[K]): void {
    this.listeners[event]?.forEach(listener => listener(...args));
  }

  protected removeAllListeners(): void {
    for (const key of Object.keys(this.listeners)) {
      delete this.listeners[key as keyof Events];
    }
  }
}
