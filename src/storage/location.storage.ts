import * as path from 'path';

import {
  AgentId,
  EntityId,
  EntityType,
  GimmickId,
  LocationEntityState,
  LocationId,
  LocationMessage,
  LocationModel,
  LocationRepository,
  LocationState,
  UserId,
  LocationMeta,
  DEFAULT_LOCATION_META,
  LocationMission,
} from '@little-samo/samo-ai';
import {
  createDeepCopy,
  fileExists,
  ensureDirectoryExists,
  readJsonFile,
  writeJsonFile,
} from '@little-samo/samo-ai-repository-storage/utils';

/**
 * Data structure for location information including model, state, messages and entity relationships
 */
interface LocationData {
  model: LocationModel;
  modelPath: string;
  state: LocationState;
  statePath: string;
  messages: LocationMessage[];
  entityStates: Map<string, LocationEntityState>;
}

/**
 * Database structure for storing multiple locations
 */
interface LocationDatabase {
  locations: Map<LocationId, LocationData>;
}

/**
 * Storage service for location data with persistence to filesystem
 * Manages location models, states, messages, and relationships with entities
 */
export class LocationStorage implements LocationRepository {
  private database: LocationDatabase = {
    locations: new Map(),
  };

  private savePromise: Promise<void> = Promise.resolve();
  private saveQueue: Map<
    LocationId,
    { timeoutId: NodeJS.Timeout; resolve: () => void }
  > = new Map();
  private saveQueueDelay: number = 50;

  public constructor(
    private readonly modelsBasePath: string,
    private readonly statesBasePath: string
  ) {}

  /**
   * Initialize location data from model files
   * @param modelBaseNames Base names of location model files to load
   */
  public async initialize(modelBaseNames: string[]): Promise<LocationStorage> {
    // Ensure states directory exists
    await ensureDirectoryExists(this.statesBasePath);

    const loadPromises = modelBaseNames.map((baseName) =>
      this.loadLocationData(`${baseName}.json`)
    );

    await Promise.all(loadPromises);
    return this;
  }

  /**
   * Load location data from model and state files
   * @param filename The filename of the location model
   */
  private async loadLocationData(filename: string): Promise<void> {
    const modelPath = path.join(this.modelsBasePath, filename);

    if (!(await fileExists(modelPath))) {
      throw new Error(`Location model file not found: ${modelPath}`);
    }

    const statePath = path.join(this.statesBasePath, filename);

    const modelJson = await readJsonFile<LocationModel>(modelPath);
    if (!modelJson) {
      throw new Error(`Failed to read model file: ${modelPath}`);
    }

    const locationId = Number(modelJson.id) as LocationId;
    this.database.locations.set(locationId, {
      model: modelJson,
      modelPath,
      state: {
        locationId,
        agentIds: [],
        userIds: [],
        canvases: {},
        pauseUpdateUntil: null,
        pauseUpdateReason: null,
        pauseUpdateNextAgentId: null,
        images: [],
        rendering: null,
        mission: null,
        remainingAgentExecutions: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      messages: [],
      statePath,
      entityStates: new Map(),
    });

    try {
      const stateData = await readJsonFile<{
        state: LocationState;
        messages?: LocationMessage[];
        entityStates?: Record<string, LocationEntityState>;
      }>(statePath);

      if (stateData) {
        const locationData = this.database.locations.get(locationId)!;
        locationData.state = stateData.state;
        locationData.messages = stateData.messages || [];
        if (stateData.entityStates) {
          locationData.entityStates = new Map(
            Object.entries(stateData.entityStates)
          );
        }
      }
    } catch (error) {
      console.warn(
        `Failed to load location state file ${statePath}, using default state:`,
        error
      );
    }
  }

  /**
   * Get list of all location IDs currently stored
   * @returns Array of location IDs
   */
  public getLocationIds(): LocationId[] {
    return Array.from(this.database.locations.keys());
  }

  /**
   * Queue state save operation with debouncing
   * @param locationId The location ID to save state for
   */
  private async saveState(locationId: LocationId): Promise<void> {
    if (this.saveQueue.has(locationId)) {
      const queueItem = this.saveQueue.get(locationId)!;
      clearTimeout(queueItem.timeoutId);
      queueItem.resolve();
    }

    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(async () => {
        this.saveQueue.delete(locationId);
        try {
          await this.executeSave(locationId);
        } catch (error) {
          console.error(
            `Error saving state for location ${locationId}:`,
            error
          );
        } finally {
          resolve();
        }
      }, this.saveQueueDelay);

      this.saveQueue.set(locationId, { timeoutId, resolve });
    });
  }

  /**
   * Execute the actual save operation to filesystem
   * Uses a promise chain to prevent concurrent writes
   */
  private async executeSave(locationId: LocationId): Promise<void> {
    const saveOperation = this.savePromise.then(async () => {
      const locationData = this.database.locations.get(locationId);
      if (!locationData) {
        throw new Error(`Location not found: ${locationId}`);
      }

      const stateData = {
        state: locationData.state,
        messages: locationData.messages,
        entityStates: Object.fromEntries(locationData.entityStates),
      };

      await writeJsonFile(locationData.statePath, stateData);
    });

    this.savePromise = saveOperation.catch(() => {});
    await saveOperation;
  }

  /**
   * Get location model by ID
   * Returns a deep copy to prevent modification of internal state
   */
  public async getLocationModel(
    locationId: LocationId
  ): Promise<LocationModel> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }
    // Important: Return a deep copy to prevent external modification
    return createDeepCopy(locationData.model);
  }

  /**
   * Get location messages with limit
   * @param locationId The location ID
   * @param limit Maximum number of messages to return
   * @returns Array of location messages
   */
  public async getLocationMessages(
    locationId: LocationId,
    limit: number
  ): Promise<LocationMessage[]> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    // Return the most recent messages up to the limit
    return locationData.messages.slice(-limit);
  }

  /**
   * Create a new location model with the specified parameters
   * @param locationId The unique identifier for the location
   * @param name The name of the location
   * @param options Optional parameters including meta
   * @returns The created LocationModel
   */
  public async createLocationModel(
    locationId: LocationId,
    name: string,
    options?: {
      meta?: LocationMeta;
    }
  ): Promise<LocationModel> {
    // Check if location already exists
    if (this.database.locations.has(locationId)) {
      throw new Error(`Location with ID ${locationId} already exists`);
    }

    const locationModel: LocationModel = {
      id: locationId,
      name,
      meta: options?.meta ?? createDeepCopy(DEFAULT_LOCATION_META),
    };

    // Create the model file path
    const modelPath = path.join(this.modelsBasePath, `${locationId}.json`);
    const statePath = path.join(this.statesBasePath, `${locationId}.json`);

    // Initialize location data in memory
    this.database.locations.set(locationId, {
      model: locationModel,
      modelPath,
      state: {
        locationId,
        agentIds: [],
        userIds: [],
        canvases: {},
        pauseUpdateUntil: null,
        pauseUpdateReason: null,
        pauseUpdateNextAgentId: null,
        images: [],
        rendering: null,
        mission: null,
        remainingAgentExecutions: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      messages: [],
      statePath,
      entityStates: new Map(),
    });

    await writeJsonFile(modelPath, locationModel);

    // Return a deep copy to prevent external modification
    return createDeepCopy(locationModel);
  }

  /**
   * Get or create location state
   * Returns a deep copy to prevent modification of internal state
   */
  public async getOrCreateLocationState(
    locationId: LocationId
  ): Promise<LocationState> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }
    // Important: Return a deep copy to ensure state is not modified externally
    return createDeepCopy(locationData.state);
  }

  /**
   * Get or create location entity state (relationship between location and an entity)
   * Returns a deep copy to prevent modification of internal state
   */
  public async getOrCreateLocationEntityState(
    locationId: LocationId,
    type: EntityType,
    entityId: EntityId
  ): Promise<LocationEntityState> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    const entityKey = `${type}:${entityId}`;

    if (!locationData.entityStates.has(entityKey)) {
      const newEntityState: LocationEntityState = {
        locationId,
        targetType: type,
        targetId: entityId,
        isActive: true,
        expression: '',
        canvases: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      locationData.entityStates.set(entityKey, newEntityState);
    }

    // Important: Return a deep copy to prevent external modification
    return createDeepCopy(locationData.entityStates.get(entityKey)!);
  }

  /**
   * Get or create multiple location entity states for different entity types
   * Returns deep copies to prevent modification of internal state
   */
  public async getOrCreateLocationEntityStates(
    locationId: LocationId,
    agentIds: AgentId[],
    userIds: UserId[],
    gimmickIds: GimmickId[]
  ): Promise<LocationEntityState[]> {
    const result: LocationEntityState[] = [];

    for (const agentId of agentIds) {
      const entityState = await this.getOrCreateLocationEntityState(
        locationId,
        EntityType.Agent,
        agentId
      );
      result.push(entityState);
    }

    for (const userId of userIds) {
      const entityState = await this.getOrCreateLocationEntityState(
        locationId,
        EntityType.User,
        userId
      );
      result.push(entityState);
    }

    for (const gimmickId of gimmickIds) {
      const entityState = await this.getOrCreateLocationEntityState(
        locationId,
        EntityType.Gimmick,
        gimmickId
      );
      result.push(entityState);
    }

    return result;
  }

  /**
   * Add an agent to a location
   * Returns true if agent was added, false if already present
   */
  public async addLocationStateAgentId(
    locationId: LocationId,
    agentId: AgentId
  ): Promise<boolean> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    if (locationData.state.agentIds.includes(agentId)) {
      return false;
    }

    locationData.state.agentIds.push(agentId);
    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
    return true;
  }

  /**
   * Remove an agent from a location
   * Returns true if agent was removed, false if not found
   */
  public async removeLocationStateAgentId(
    locationId: LocationId,
    agentId: AgentId
  ): Promise<boolean> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    const index = locationData.state.agentIds.indexOf(agentId);
    if (index === -1) {
      return false;
    }

    locationData.state.agentIds.splice(index, 1);
    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
    return true;
  }

  /**
   * Add a user to a location
   * Returns true if user was added, false if already present
   */
  public async addLocationStateUserId(
    locationId: LocationId,
    userId: UserId
  ): Promise<boolean> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    if (locationData.state.userIds.includes(userId)) {
      return false;
    }

    locationData.state.userIds.push(userId);
    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
    return true;
  }

  /**
   * Remove a user from a location
   * Returns true if user was removed, false if not found
   */
  public async removeLocationStateUserId(
    locationId: LocationId,
    userId: UserId
  ): Promise<boolean> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    const index = locationData.state.userIds.indexOf(userId);
    if (index === -1) {
      return false;
    }

    locationData.state.userIds.splice(index, 1);
    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
    return true;
  }

  /**
   * Update pause time for location updates
   * Used to temporarily prevent processing while UI catches up
   */
  public async updateLocationStatePauseUpdateUntil(
    locationId: LocationId,
    pauseUpdateUntil: Date | null
  ): Promise<void> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    locationData.state.pauseUpdateUntil = pauseUpdateUntil;
    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
  }

  /**
   * Update a location's canvas content
   * Canvases are shared drawing/text areas in a location
   */
  public async updateLocationStateCanvas(
    locationId: LocationId,
    canvasName: string,
    modifierEntityType: EntityType,
    modifierEntityId: EntityId,
    text: string
  ): Promise<void> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    if (!locationData.state.canvases) {
      locationData.state.canvases = {};
    }

    const now = new Date();
    const existing = locationData.state.canvases[canvasName];

    locationData.state.canvases[canvasName] = {
      ...existing,
      text,
      lastModifierEntityType: modifierEntityType,
      lastModifierEntityId: modifierEntityId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    locationData.state.updatedAt = now;
    await this.saveState(locationId);
  }

  /**
   * Update an image at a specific index in the location's image array
   * Images are used for visual representations of the location state
   */
  public async updateLocationStateImage(
    locationId: LocationId,
    index: number,
    image: string
  ): Promise<void> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    // Ensure the images array exists and has enough elements
    if (!locationData.state.images) {
      locationData.state.images = [];
    }

    // Extend array if index is beyond current length
    while (locationData.state.images.length <= index) {
      locationData.state.images.push('');
    }

    locationData.state.images[index] = image;
    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
  }

  /**
   * Update the location's mission
   * Mission represents the current objectives and goals for the location
   */
  public async updateLocationStateMission(
    locationId: LocationId,
    mission: LocationMission | null
  ): Promise<void> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    locationData.state.mission = mission;
    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
  }

  /**
   * Update a specific objective within the location's mission
   * Updates completion status and timestamp for a mission objective
   */
  public async updateLocationStateMissionObjective(
    locationId: LocationId,
    objectiveIndex: number,
    completed: boolean,
    completedAt?: Date
  ): Promise<void> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    if (!locationData.state.mission) {
      throw new Error(`Location ${locationId} has no active mission`);
    }

    if (!locationData.state.mission.objectives) {
      throw new Error(`Mission has no objectives array`);
    }

    if (
      objectiveIndex < 0 ||
      objectiveIndex >= locationData.state.mission.objectives.length
    ) {
      throw new Error(
        `Objective index ${objectiveIndex} is out of bounds (0-${locationData.state.mission.objectives.length - 1})`
      );
    }

    locationData.state.mission.objectives[objectiveIndex].completed = completed;
    if (completedAt !== undefined) {
      locationData.state.mission.objectives[objectiveIndex].completedAt =
        completedAt;
    }

    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
  }

  /**
   * Update the location's rendering content
   * Rendering represents the current visual or textual description of the location
   */
  public async updateLocationStateRendering(
    locationId: LocationId,
    rendering: string | null
  ): Promise<void> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    locationData.state.rendering = rendering;
    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
  }

  /**
   * Update remaining agent executions for a location
   */
  public async updateLocationStateRemainingAgentExecutions(
    locationId: LocationId,
    value:
      | {
          remainingAgentExecutions: number | null;
        }
      | {
          remainingAgentExecutionsDelta: number;
        }
  ): Promise<void> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    if ('remainingAgentExecutions' in value) {
      locationData.state.remainingAgentExecutions =
        value.remainingAgentExecutions;
    } else if ('remainingAgentExecutionsDelta' in value) {
      const current = locationData.state.remainingAgentExecutions;
      if (current !== null) {
        locationData.state.remainingAgentExecutions =
          current + value.remainingAgentExecutionsDelta;
      }
    }

    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
  }

  /**
   * Add a message to a location's history
   * Uses deep copy to ensure data safety
   */
  public async addLocationMessage(
    locationId: LocationId,
    message: LocationMessage,
    maxMessages?: number
  ): Promise<void> {
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    // Important: Create deep copy to ensure message doesn't reference external data
    const messageCopy = createDeepCopy(message);
    locationData.messages.push(messageCopy);

    if (maxMessages && locationData.messages.length > maxMessages) {
      const excess = locationData.messages.length - maxMessages;
      locationData.messages.splice(0, excess);
    }

    locationData.state.updatedAt = new Date();
    await this.saveState(locationId);
  }

  /**
   * Update an entity's active status in this location
   */
  public async updateLocationEntityStateIsActive(
    locationId: LocationId,
    targetType: EntityType,
    targetId: EntityId,
    isActive: boolean
  ): Promise<void> {
    await this.getOrCreateLocationEntityState(locationId, targetType, targetId);

    const entityKey = `${targetType}:${targetId}`;
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    const entityState = locationData.entityStates.get(entityKey)!;
    entityState.isActive = isActive;
    entityState.updatedAt = new Date();
    await this.saveState(locationId);
  }

  /**
   * Update an entity's expression in this location
   * Expressions represent emotional states or visual appearances
   */
  public async updateLocationEntityStateExpression(
    locationId: LocationId,
    targetType: EntityType,
    targetId: EntityId,
    expression: string
  ): Promise<void> {
    const entityKey = `${targetType}:${targetId}`;
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    await this.getOrCreateLocationEntityState(locationId, targetType, targetId);

    const entityState = locationData.entityStates.get(entityKey)!;
    entityState.expression = expression;
    entityState.updatedAt = new Date();
    await this.saveState(locationId);
  }

  /**
   * Update an entity's personal canvas in this location
   * These are individual canvases not shared with the entire location
   */
  public async updateLocationEntityStateCanvas(
    locationId: LocationId,
    targetType: EntityType,
    targetId: EntityId,
    canvasName: string,
    text: string
  ): Promise<void> {
    const entityKey = `${targetType}:${targetId}`;
    const locationData = this.database.locations.get(locationId);
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    await this.getOrCreateLocationEntityState(locationId, targetType, targetId);

    const entityState = locationData.entityStates.get(entityKey)!;
    if (!entityState.canvases) {
      entityState.canvases = {};
    }

    const now = new Date();
    const existing = entityState.canvases[canvasName];

    entityState.canvases[canvasName] = {
      text,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    entityState.updatedAt = now;
    await this.saveState(locationId);
  }
}
