import * as fs from 'fs/promises';
import * as path from 'path';

import {
  AgentId,
  EntityId,
  EntityType,
  GimmickId,
  LocationEntityState,
  LocationId,
  LocationMessage,
  LocationMessagesState,
  LocationModel,
  LocationRepository,
  LocationState,
  UserId,
  LocationMeta,
  DEFAULT_LOCATION_META,
  sleep,
} from '@little-samo/samo-ai';
import {
  createDeepCopy,
  fileExists,
} from '@little-samo/samo-ai-repository-storage/utils';

/**
 * Data structure for location information including model, state, messages and entity relationships
 */
interface LocationData {
  model: LocationModel;
  modelPath: string;
  state: LocationState;
  statePath: string;
  messagesState: LocationMessagesState;
  entityStates: Record<string, LocationEntityState>;
}

/**
 * Database structure for storing multiple locations
 */
interface LocationDatabase {
  locations: Record<LocationId, LocationData>;
}

/**
 * Storage service for location data with persistence to filesystem
 * Manages location models, states, messages, and relationships with entities
 */
export class LocationStorage implements LocationRepository {
  private database: LocationDatabase = {
    locations: {},
  };

  private saveInProgress: boolean = false;
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

    const modelContent = await fs.readFile(modelPath, 'utf-8');
    const modelJson = JSON.parse(modelContent);

    const locationId = Number(modelJson.id) as LocationId;
    this.database.locations[locationId] = {
      model: modelJson,
      modelPath,
      state: {
        locationId,
        agentIds: [],
        userIds: [],
        canvases: {},
        pauseUpdateUntil: null,
        images: [],
        rendering: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      messagesState: {
        locationId,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      statePath,
      entityStates: {},
    };

    if (await fileExists(statePath)) {
      try {
        const stateContent = await fs.readFile(statePath, 'utf-8');
        const stateData = JSON.parse(stateContent);

        this.database.locations[locationId].state = stateData.state;
        this.database.locations[locationId].messagesState =
          stateData.messagesState;
        this.database.locations[locationId].entityStates =
          stateData.entityStates;
      } catch (error) {
        console.warn(
          `Failed to load location state file ${statePath}, using default state:`,
          error
        );
      }
    }
  }

  /**
   * Get list of all location IDs currently stored
   * @returns Array of location IDs
   */
  public getLocationIds(): LocationId[] {
    return Object.keys(this.database.locations).map(
      (id) => Number(id) as LocationId
    );
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
        try {
          await this.executeSave(locationId);
          this.saveQueue.delete(locationId);
          resolve();
        } catch (error) {
          console.error(
            `Error saving state for location ${locationId}:`,
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
        throw new Error(`Location not found: ${locationId}`);
      }

      const stateData = {
        state: locationData.state,
        messagesState: locationData.messagesState,
        entityStates: locationData.entityStates,
      };

      const stateJson = JSON.stringify(stateData, null, 2);
      await fs.writeFile(locationData.statePath, stateJson);
    } finally {
      this.saveInProgress = false;
    }
  }

  /**
   * Get location model by ID
   * Returns a deep copy to prevent modification of internal state
   */
  public async getLocationModel(
    locationId: LocationId
  ): Promise<LocationModel> {
    const locationData = this.database.locations[locationId];
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }
    // Important: Return a deep copy to prevent external modification
    return createDeepCopy(locationData.model);
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
    if (this.database.locations[locationId]) {
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
    this.database.locations[locationId] = {
      model: locationModel,
      modelPath,
      state: {
        locationId,
        agentIds: [],
        userIds: [],
        canvases: {},
        pauseUpdateUntil: null,
        images: [],
        rendering: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      messagesState: {
        locationId,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      statePath,
      entityStates: {},
    };

    // Save the model to file
    const modelJson = JSON.stringify(locationModel, null, 2);
    await fs.writeFile(modelPath, modelJson);

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
    if (!this.database.locations[locationId]) {
      throw new Error(`Location not found: ${locationId}`);
    }
    // Important: Return a deep copy to ensure state is not modified externally
    return createDeepCopy(this.database.locations[locationId].state);
  }

  /**
   * Get or create location messages state
   * Returns a deep copy to prevent modification of internal state
   */
  public async getOrCreateLocationMessagesState(
    locationId: LocationId
  ): Promise<LocationMessagesState> {
    if (!this.database.locations[locationId]) {
      throw new Error(`Location not found: ${locationId}`);
    }
    // Important: Return a deep copy to ensure messages are not modified externally
    return createDeepCopy(this.database.locations[locationId].messagesState);
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
    const locationData = this.database.locations[locationId];
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    const entityKey = `${type}:${entityId}`;

    if (!locationData.entityStates[entityKey]) {
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

      locationData.entityStates[entityKey] = newEntityState;
    }

    // Important: Return a deep copy to prevent external modification
    return createDeepCopy(locationData.entityStates[entityKey]);
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
    const locationData = this.database.locations[locationId];
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
    const locationData = this.database.locations[locationId];
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
    const locationData = this.database.locations[locationId];
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
    const locationData = this.database.locations[locationId];
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
    const locationData = this.database.locations[locationId];
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
    const locationData = this.database.locations[locationId];
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    if (!locationData.state.canvases) {
      locationData.state.canvases = {};
    }

    locationData.state.canvases[canvasName] = {
      text,
      lastModifierEntityType: modifierEntityType,
      lastModifierEntityId: modifierEntityId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    locationData.state.updatedAt = new Date();
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
    const locationData = this.database.locations[locationId];
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
   * Update the location's rendering content
   * Rendering represents the current visual or textual description of the location
   */
  public async updateLocationStateRendering(
    locationId: LocationId,
    rendering: string | null
  ): Promise<void> {
    const locationData = this.database.locations[locationId];
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    locationData.state.rendering = rendering;
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
    const locationData = this.database.locations[locationId];
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    // Important: Create deep copy to ensure message doesn't reference external data
    const messageCopy = createDeepCopy(message);
    locationData.messagesState.messages.push(messageCopy);

    if (
      maxMessages &&
      locationData.messagesState.messages.length > maxMessages
    ) {
      const excess = locationData.messagesState.messages.length - maxMessages;
      locationData.messagesState.messages.splice(0, excess);
    }

    locationData.messagesState.updatedAt = new Date();
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
    const locationData = this.database.locations[locationId];
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    locationData.entityStates[entityKey].isActive = isActive;
    locationData.entityStates[entityKey].updatedAt = new Date();
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
    const locationData = this.database.locations[locationId];
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    await this.getOrCreateLocationEntityState(locationId, targetType, targetId);

    locationData.entityStates[entityKey].expression = expression;
    locationData.entityStates[entityKey].updatedAt = new Date();
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
    const locationData = this.database.locations[locationId];
    if (!locationData) {
      throw new Error(`Location not found: ${locationId}`);
    }

    await this.getOrCreateLocationEntityState(locationId, targetType, targetId);

    if (!locationData.entityStates[entityKey].canvases) {
      locationData.entityStates[entityKey].canvases = {};
    }

    locationData.entityStates[entityKey].canvases[canvasName] = {
      text,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    locationData.entityStates[entityKey].updatedAt = new Date();
    await this.saveState(locationId);
  }
}
