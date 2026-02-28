/**
 * Coalescing save queue that batches and deduplicates write operations per key.
 *
 * Guarantees:
 * - At most ONE active disk write per key at any time
 * - Rapid mutations within the debounce window are batched into a single write
 * - Mutations arriving during an active write are coalesced into ONE additional write
 * - Different keys can save concurrently (they target different files)
 */
export class SaveQueue<K = string> {
  private debounceTimers = new Map<K, NodeJS.Timeout>();
  private activeSaves = new Set<K>();
  private dirtyWhileSaving = new Set<K>();

  public constructor(
    private readonly delayMs: number,
    private readonly saveFn: (key: K) => Promise<void>,
    private readonly onError?: (key: K, error: unknown) => void
  ) {}

  /**
   * Request a save for the given key.
   * - If idle: debounces then saves
   * - If already saving: marks dirty, resolves immediately (save will follow)
   */
  public async requestSave(key: K): Promise<void> {
    if (this.activeSaves.has(key)) {
      this.dirtyWhileSaving.add(key);
      return;
    }

    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    return new Promise<void>((resolve) => {
      const timer = setTimeout(async () => {
        this.debounceTimers.delete(key);
        await this.flush(key);
        resolve();
      }, this.delayMs);
      this.debounceTimers.set(key, timer);
    });
  }

  private async flush(key: K): Promise<void> {
    this.activeSaves.add(key);
    this.dirtyWhileSaving.delete(key);

    try {
      await this.saveFn(key);
    } catch (error) {
      if (this.onError) {
        this.onError(key, error);
      } else {
        console.error(`Error saving key ${key}:`, error);
      }
    } finally {
      this.activeSaves.delete(key);
    }

    if (this.dirtyWhileSaving.has(key)) {
      this.dirtyWhileSaving.delete(key);
      await this.flush(key);
    }
  }
}
