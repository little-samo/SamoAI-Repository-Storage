import * as fs from 'fs/promises';
import * as path from 'path';

import {
  EntityId,
  EntityType,
  GimmickId,
  GimmickRepository,
  GimmickState,
  LocationId,
  sleep,
} from '@little-samo/samo-ai';
import {
  createDeepCopy,
  fileExists,
  ensureDirectoryExists,
} from '@little-samo/samo-ai-repository-storage/utils';

/**
 * Data structure for gimmick states within a specific location
 */
interface LocationGimmickData {
  gimmickStates: Map<GimmickId, GimmickState>;
  statePath: string;
}

/**
 * Database structure for storing gimmick states across multiple locations
 */
interface GimmickDatabase {
  locations: Map<LocationId, LocationGimmickData>;
}

/**
 * File-based storage for gimmick data with persistence to filesystem
 * Manages gimmick states per location, as gimmick IDs are only unique within a location
 */
export class GimmickStorage implements GimmickRepository {
  private database: GimmickDatabase = {
    locations: new Map(),
  };

  private saveInProgress: boolean = false;
  private saveQueue: Map<
    LocationId,
    { timeoutId: NodeJS.Timeout; resolve: () => void }
  > = new Map();
  private saveQueueDelay: number = 50;

  public constructor(private readonly statesBasePath: string) {}

  /**
   * Initialize gimmick data for specific locations
   * @param locationIds Array of location IDs to initialize
   */
  public async initialize(locationIds: LocationId[]): Promise<GimmickStorage> {
    // Ensure states directory exists
    await ensureDirectoryExists(this.statesBasePath);

    const loadPromises = locationIds.map((locationId) =>
      this.loadLocationGimmickData(locationId)
    );

    await Promise.all(loadPromises);
    return this;
  }

  /**
   * Load gimmick data for a specific location from state file
   * @param locationId The location ID to load gimmick data for
   */
  private async loadLocationGimmickData(locationId: LocationId): Promise<void> {
    const statePath = path.join(
      this.statesBasePath,
      `gimmicks_${locationId}.json`
    );

    this.database.locations.set(locationId, {
      gimmickStates: new Map(),
      statePath,
    });

    try {
      if (await fileExists(statePath)) {
        const stateContent = await fs.readFile(statePath, 'utf-8');
        const stateData = JSON.parse(stateContent);

        const gimmickStates = stateData.gimmickStates || {};
        const gimmickStatesMap = new Map<GimmickId, GimmickState>();
        for (const [key, value] of Object.entries(gimmickStates)) {
          gimmickStatesMap.set(key as GimmickId, value as GimmickState);
        }
        this.database.locations.get(locationId)!.gimmickStates = gimmickStatesMap;
      }
    } catch (error) {
      console.warn(
        `Failed to load gimmick state file ${statePath}, using default state:`,
        error
      );
    }
  }

  /**
   * Queue state save operation with debouncing
   * @param locationId The location ID to save gimmick states for
   */
  private async saveState(locationId: LocationId): Promise<void> {
    if (this.saveQueue.has(locationId)) {
      const queueItem = this.saveQueue.get(locationId)!;
      clearTimeout(queueItem.timeoutId);
      queueItem.resolve();
    }

    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(async () => {
        try {
          await this.executeSave(locationId);
          this.saveQueue.delete(locationId);
          resolve();
        } catch (error) {
          console.error(
            `Error saving gimmick states for location ${locationId}:`,
            error
          );
          this.saveQueue.delete(locationId);
          resolve();
        }
      }, this.saveQueueDelay);

      this.saveQueue.set(locationId, { timeoutId, resolve });
    });
  }

  /**
   * Execute the actual save operation to filesystem
   * Uses a lock to prevent concurrent writes
   */
  private async executeSave(locationId: LocationId): Promise<void> {
    const waitForLock = async (): Promise<void> => {
      if (this.saveInProgress) {
        await sleep(10);
        return waitForLock();
      }
      return;
    };

    await waitForLock();

    try {
      this.saveInProgress = true;

      const locationData = this.database.locations.get(locationId);
      if (!locationData) {
        throw new Error(`Location gimmick data not found: ${locationId}`);
      }

      const stateData = {
        gimmickStates: Object.fromEntries(locationData.gimmickStates),
      };

      const stateJson = JSON.stringify(stateData, null, 2);
      await fs.writeFile(locationData.statePath, stateJson);
    } finally {
      this.saveInProgress = false;
    }
  }

  /**
   * Ensure location data exists in memory
   * @param locationId The location ID to ensure exists
   */
  private async ensureLocationExists(locationId: LocationId): Promise<void> {
    if (!this.database.locations.has(locationId)) {
      await this.loadLocationGimmickData(locationId);
    }
  }

  /**
   * Get or create a gimmick state for a specific location
   * Returns a deep copy to prevent modification of internal state
   */
  public async getOrCreateGimmickState(
    locationId: LocationId,
    gimmickId: GimmickId
  ): Promise<GimmickState> {
    await this.ensureLocationExists(locationId);

    const locationData = this.database.locations.get(locationId)!;

    if (!locationData.gimmickStates.has(gimmickId)) {
      // Create a new gimmick state
      const newGimmickState: GimmickState = {
        locationId,
        gimmickId,
        updatedAt: new Date(),
        createdAt: new Date(),
      };
      locationData.gimmickStates.set(gimmickId, newGimmickState);

      // Save the new state to disk
      await this.saveState(locationId);
    }

    // Important: Return a deep copy to prevent external modification
    return createDeepCopy(locationData.gimmickStates.get(gimmickId)!);
  }

  /**
   * Get or create multiple gimmick states for a specific location
   * Returns deep copies to prevent modification of internal state
   */
  public async getOrCreateGimmickStates(
    locationId: LocationId,
    gimmickIds: GimmickId[]
  ): Promise<Map<GimmickId, GimmickState>> {
    const result = new Map<GimmickId, GimmickState>();

    await Promise.all(
      gimmickIds.map(async (gimmickId) => {
        const state = await this.getOrCreateGimmickState(
          locationId,
          gimmickId
        );
        result.set(gimmickId, state);
      })
    );

    return result;
  }

  /**
   * Update a gimmick's occupier information
   * Changes are persisted to disk
   */
  public async updateGimmickStateOccupier(
    locationId: LocationId,
    gimmickId: GimmickId,
    occupierType?: EntityType,
    occupierId?: EntityId,
    occupationUntil?: Date
  ): Promise<void> {
    await this.ensureLocationExists(locationId);

    const locationData = this.database.locations.get(locationId)!;

    // Ensure gimmick state exists
    if (!locationData.gimmickStates.has(gimmickId)) {
      await this.getOrCreateGimmickState(locationId, gimmickId);
    }

    const gimmickState = locationData.gimmickStates.get(gimmickId)!;
    gimmickState.occupierType = occupierType;
    gimmickState.occupierId = occupierId;
    gimmickState.occupationUntil = occupationUntil;
    gimmickState.updatedAt = new Date();

    await this.saveState(locationId);
  }
}
