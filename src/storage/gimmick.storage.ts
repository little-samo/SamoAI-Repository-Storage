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
} from '@little-samo/samo-ai-repository-storage/utils';

/**
 * Data structure for gimmick states within a specific location
 */
interface LocationGimmickData {
  gimmickStates: Record<GimmickId, GimmickState>;
  statePath: string;
}

/**
 * Database structure for storing gimmick states across multiple locations
 */
interface GimmickDatabase {
  locations: Record<LocationId, LocationGimmickData>;
}

/**
 * File-based storage for gimmick data with persistence to filesystem
 * Manages gimmick states per location, as gimmick IDs are only unique within a location
 */
export class GimmickStorage implements GimmickRepository {
  private database: GimmickDatabase = {
    locations: {},
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

    this.database.locations[locationId] = {
      gimmickStates: {},
      statePath,
    };

    try {
      if (await fileExists(statePath)) {
        const stateContent = await fs.readFile(statePath, 'utf-8');
        const stateData = JSON.parse(stateContent);

        this.database.locations[locationId].gimmickStates =
          stateData.gimmickStates || {};
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

      const locationData = this.database.locations[locationId];
      if (!locationData) {
        throw new Error(`Location gimmick data not found: ${locationId}`);
      }

      const stateData = {
        gimmickStates: locationData.gimmickStates,
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
    if (!this.database.locations[locationId]) {
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

    const locationData = this.database.locations[locationId];

    if (!locationData.gimmickStates[gimmickId]) {
      // Create a new gimmick state
      locationData.gimmickStates[gimmickId] = {
        locationId,
        gimmickId,
        updatedAt: new Date(),
        createdAt: new Date(),
      };

      // Save the new state to disk
      await this.saveState(locationId);
    }

    // Important: Return a deep copy to prevent external modification
    return createDeepCopy(locationData.gimmickStates[gimmickId]);
  }

  /**
   * Get or create multiple gimmick states for a specific location
   * Returns deep copies to prevent modification of internal state
   */
  public async getOrCreateGimmickStates(
    locationId: LocationId,
    gimmickIds: GimmickId[]
  ): Promise<Record<GimmickId, GimmickState>> {
    const result: Record<GimmickId, GimmickState> = {};

    await Promise.all(
      gimmickIds.map(async (gimmickId) => {
        result[gimmickId] = await this.getOrCreateGimmickState(
          locationId,
          gimmickId
        );
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

    const locationData = this.database.locations[locationId];

    // Ensure gimmick state exists
    if (!locationData.gimmickStates[gimmickId]) {
      await this.getOrCreateGimmickState(locationId, gimmickId);
    }

    const gimmickState = locationData.gimmickStates[gimmickId];
    gimmickState.occupierType = occupierType;
    gimmickState.occupierId = occupierId;
    gimmickState.occupationUntil = occupationUntil;
    gimmickState.updatedAt = new Date();

    await this.saveState(locationId);
  }
}
