import * as path from 'path';

import {
  EntityId,
  EntityType,
  GimmickId,
  GimmickRepository,
  GimmickState,
  LocationId,
} from '@little-samo/samo-ai';
import {
  createDeepCopy,
  ensureDirectoryExists,
  readJsonFile,
  writeJsonFile,
  SaveQueue,
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

  private saves = new SaveQueue<LocationId>(50, (locationId) =>
    this.executeSave(locationId)
  );

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
      const stateData = await readJsonFile<{
        gimmickStates?: Record<string, GimmickState>;
      }>(statePath);

      if (stateData?.gimmickStates) {
        this.database.locations.get(locationId)!.gimmickStates = new Map(
          Object.entries(stateData.gimmickStates) as [GimmickId, GimmickState][]
        );
      }
    } catch (error) {
      console.warn(
        `Failed to load gimmick state file ${statePath}, using default state:`,
        error
      );
    }
  }

  private async saveState(locationId: LocationId): Promise<void> {
    await this.saves.requestSave(locationId);
  }

  private async executeSave(locationId: LocationId): Promise<void> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location gimmick data not found: ${locationId}`);
    }

    const stateData = {
      gimmickStates: Object.fromEntries(locationData.gimmickStates),
    };

    await writeJsonFile(locationData.statePath, stateData);
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

    // Sequential to avoid concurrent saves to the same location file
    for (const gimmickId of gimmickIds) {
      const state = await this.getOrCreateGimmickState(locationId, gimmickId);
      result.set(gimmickId, state);
    }

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
    occupationUntil?: Date,
    options?: {
      currentOccupierType?: EntityType;
      currentOccupierId?: EntityId;
    }
  ): Promise<void> {
    await this.ensureLocationExists(locationId);

    const locationData = this.database.locations.get(locationId)!;

    if (!locationData.gimmickStates.has(gimmickId)) {
      await this.getOrCreateGimmickState(locationId, gimmickId);
    }

    const gimmickState = locationData.gimmickStates.get(gimmickId)!;

    if (
      options?.currentOccupierType !== undefined &&
      gimmickState.occupierType !== options.currentOccupierType
    ) {
      return;
    }
    if (
      options?.currentOccupierId !== undefined &&
      gimmickState.occupierId !== options.currentOccupierId
    ) {
      return;
    }

    if (occupierType) {
      gimmickState.occupierType = occupierType;
      gimmickState.occupierId = occupierId;
      gimmickState.occupationUntil = occupationUntil;
    } else {
      delete gimmickState.occupierType;
      delete gimmickState.occupierId;
      delete gimmickState.occupationUntil;
    }
    gimmickState.updatedAt = new Date();

    await this.saveState(locationId);
  }
}
