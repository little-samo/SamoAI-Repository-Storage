import { sleep } from './sleep';

/**
 * Coalescing save queue that batches and deduplicates write operations per key.
 *
 * Guarantees:
 * - At most ONE active disk write per key at any time
 * - Rapid mutations within the debounce window are batched into a single write
 * - Mutations arriving during an active write are coalesced into ONE additional write
 * - Different keys can save concurrently (they target different files)
 * - A cooldown gap between consecutive writes to the same key prevents
 *   Windows EPERM from delayed file handle release
 */
export class SaveQueue<K = string> {
  private debounceTimers = new Map<K, NodeJS.Timeout>();
  private activeSaves = new Set<K>();
  private dirtyWhileSaving = new Set<K>();

  // Optional: resolve functions for pending promises
  private pendingResolvers = new Map<K, Array<() => void>>();

  public constructor(
    private readonly delayMs: number,
    private readonly saveFn: (key: K) => Promise<void>,
    private readonly onError?: (key: K, error: unknown) => void
  ) {}

  /**
   * Request a save for the given key.
   * - If idle: waits delayMs then saves
   * - If already waiting for delay: joins the existing wait
   * - If already saving: marks dirty, save will follow after current save
   */
  public async requestSave(key: K): Promise<void> {
    return new Promise<void>((resolve) => {
      // Queue the resolve function for the requested save.
      let resolvers = this.pendingResolvers.get(key);
      if (!resolvers) {
        resolvers = [];
        this.pendingResolvers.set(key, resolvers);
      }
      resolvers.push(resolve);

      if (this.activeSaves.has(key)) {
        this.dirtyWhileSaving.add(key);
        return;
      }

      if (this.debounceTimers.has(key)) {
        // If a save is already scheduled, ignore without resetting the timer.
        // When the existing timer expires, it will flush and resolve all pending promises.
        return;
      }

      const timer = setTimeout(async () => {
        this.debounceTimers.delete(key);
        await this.flush(key);
      }, this.delayMs);
      this.debounceTimers.set(key, timer);
    });
  }

  private async flush(key: K): Promise<void> {
    this.activeSaves.add(key);

    try {
      while (true) {
        this.dirtyWhileSaving.delete(key);

        try {
          await this.saveFn(key);
        } catch (error) {
          if (this.onError) {
            this.onError(key, error);
          } else {
            console.error(`Error saving key ${key}:`, error);
          }
        }

        if (this.dirtyWhileSaving.has(key)) {
          // Cooldown before writing the same file again so the OS can fully
          // release handles from the previous rename (Windows EPERM prevention)
          await sleep(this.delayMs);
          continue;
        } else {
          break;
        }
      }
    } finally {
      this.activeSaves.delete(key);

      // Resolve all pending promises.
      const resolvers = this.pendingResolvers.get(key);
      if (resolvers) {
        this.pendingResolvers.delete(key);
        for (const resolve of resolvers) {
          resolve();
        }
      }
    }
  }
}
