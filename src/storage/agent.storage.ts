import * as fs from 'fs/promises';
import * as path from 'path';

import {
  AgentId,
  AgentModel,
  AgentState,
  AgentRepository,
  UserId,
  AgentEntityState,
  EntityId,
  EntityType,
  AgentMemory,
  AgentMeta,
  DEFAULT_AGENT_META,
  sleep,
} from '@little-samo/samo-ai';
import {
  createDeepCopy,
  fileExists,
  ensureDirectoryExists,
} from '@little-samo/samo-ai-repository-storage/utils';

/**
 * Data structure for agent information including model, state and relationships
 */
interface AgentData {
  model: AgentModel;
  modelPath: string;
  state: AgentState;
  statePath: string;
  entityStates: Record<EntityId, AgentEntityState>;
}

/**
 * Database structure for storing multiple agents
 */
interface AgentDatabase {
  agents: Record<AgentId, AgentData>;
}

/**
 * Storage service for agent data with persistence to filesystem
 * Manages agent models, states, and relationships between entities
 */
export class AgentStorage implements AgentRepository {
  private database: AgentDatabase = {
    agents: {},
  };

  private saveInProgress: boolean = false;
  private saveQueue: Map<
    AgentId,
    { timeoutId: NodeJS.Timeout; resolve: () => void }
  > = new Map();
  private saveQueueDelay: number = 50;

  public constructor(
    private readonly modelsBasePath: string,
    private readonly statesBasePath: string
  ) {}

  /**
   * Initialize agent data from model files
   * @param modelBaseNames Base names of agent model files to load
   */
  public async initialize(modelBaseNames: string[]): Promise<AgentStorage> {
    // Ensure states directory exists
    await ensureDirectoryExists(this.statesBasePath);

    const loadPromises = modelBaseNames.map((baseName) =>
      this.loadAgentData(`${baseName}.json`)
    );

    await Promise.all(loadPromises);

    return this;
  }

  /**
   * Load agent data from model and state files
   * @param filename The filename of the agent model
   */
  private async loadAgentData(filename: string): Promise<void> {
    const modelPath = path.join(this.modelsBasePath, filename);

    if (!(await fileExists(modelPath))) {
      throw new Error(`Model file not found: ${modelPath}`);
    }

    const statePath = path.join(this.statesBasePath, filename);

    const modelContent = await fs.readFile(modelPath, 'utf-8');
    const modelJson = JSON.parse(modelContent);

    const agentId = Number(modelJson.id) as AgentId;
    this.database.agents[agentId] = {
      model: modelJson,
      modelPath,
      state: {
        agentId: agentId,
        memories: [],
        summary: '',
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

        this.database.agents[agentId].state = stateData.state;
        this.database.agents[agentId].entityStates = stateData.entityStates;
      } catch (error) {
        console.warn(
          `Failed to load state file ${statePath}, using default state:`,
          error
        );
      }
    }
  }

  /**
   * Get list of all agent IDs currently stored
   * @returns Array of agent IDs
   */
  public getAgentIds(): AgentId[] {
    return Object.keys(this.database.agents).map((id) => Number(id) as AgentId);
  }

  /**
   * Queue state save operation with debouncing
   * @param agentId The agent ID to save state for
   */
  private async saveState(agentId: AgentId): Promise<void> {
    if (this.saveQueue.has(agentId)) {
      // Resolve previous promise when clearing timeout
      const queueItem = this.saveQueue.get(agentId)!;
      clearTimeout(queueItem.timeoutId);
      queueItem.resolve(); // Resolve the previous promise
    }

    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(async () => {
        try {
          await this.executeSave(agentId);
          this.saveQueue.delete(agentId);
          resolve();
        } catch (error) {
          console.error(`Error saving state for agent ${agentId}:`, error);
          this.saveQueue.delete(agentId);
          resolve();
        }
      }, this.saveQueueDelay);

      // Store both the timeout ID and the resolve function
      this.saveQueue.set(agentId, { timeoutId, resolve });
    });
  }

  /**
   * Execute the actual save operation to filesystem
   * Uses a lock to prevent concurrent writes
   */
  private async executeSave(agentId: AgentId): Promise<void> {
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

      const agentData = this.database.agents[agentId];
      if (!agentData) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const stateData = {
        state: agentData.state,
        entityStates: agentData.entityStates,
      };

      const stateJson = JSON.stringify(stateData, null, 2);
      await fs.writeFile(agentData.statePath, stateJson);
    } finally {
      this.saveInProgress = false;
    }
  }

  /**
   * Get agent model by ID
   * Returns a deep copy to prevent modification of internal state
   */
  public async getAgentModel(agentId: AgentId): Promise<AgentModel> {
    const agentData = this.database.agents[agentId];
    if (!agentData) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Important: Return a deep copy to prevent external modification of stored data
    const modelCopy = createDeepCopy(agentData.model);
    modelCopy.isActive = true;
    return modelCopy;
  }

  /**
   * Get multiple agent models by IDs
   * Returns deep copies to prevent modification of internal state
   */
  public async getAgentModels(
    agentIds: AgentId[]
  ): Promise<Record<AgentId, AgentModel>> {
    const result: Record<AgentId, AgentModel> = {};
    for (const agentId of agentIds) {
      result[agentId] = await this.getAgentModel(agentId);
    }
    return result;
  }

  /**
   * Create a new agent model with the specified parameters
   * @param agentId The unique identifier for the agent
   * @param name The name of the agent
   * @param options Optional parameters including meta, username, and isActive
   * @returns The created AgentModel
   */
  public async createAgentModel(
    agentId: AgentId,
    name: string,
    options?: {
      meta?: AgentMeta;
      username?: string | null;
      isActive?: boolean;
    }
  ): Promise<AgentModel> {
    // Check if agent already exists
    if (this.database.agents[agentId]) {
      throw new Error(`Agent with ID ${agentId} already exists`);
    }

    const agentModel: AgentModel = {
      id: agentId,
      name,
      username: options?.username ?? null,
      meta: options?.meta ?? createDeepCopy(DEFAULT_AGENT_META),
      isActive: options?.isActive ?? true,
    };

    // Create the model file path
    const modelPath = path.join(this.modelsBasePath, `${agentId}.json`);
    const statePath = path.join(this.statesBasePath, `${agentId}.json`);

    // Initialize agent data in memory
    this.database.agents[agentId] = {
      model: agentModel,
      modelPath,
      state: {
        agentId: agentId,
        memories: [],
        summary: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      statePath,
      entityStates: {},
    };

    // Save the model to file
    const modelJson = JSON.stringify(agentModel, null, 2);
    await fs.writeFile(modelPath, modelJson);

    // Return a deep copy to prevent external modification
    return createDeepCopy(agentModel);
  }

  /**
   * Get or create agent state
   * Returns a deep copy to prevent modification of internal state
   */
  public async getOrCreateAgentState(agentId: AgentId): Promise<AgentState> {
    if (!this.database.agents[agentId]) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    // Important: Return a deep copy to ensure state is not modified externally
    return createDeepCopy(this.database.agents[agentId].state);
  }

  /**
   * Get or create multiple agent states
   * Returns deep copies to prevent modification of internal state
   */
  public async getOrCreateAgentStates(
    agentIds: AgentId[]
  ): Promise<Record<AgentId, AgentState>> {
    const result: Record<AgentId, AgentState> = {};
    for (const agentId of agentIds) {
      result[agentId] = await this.getOrCreateAgentState(agentId);
    }
    return result;
  }

  /**
   * Get or create agent entity state (relationship between agent and another entity)
   * Returns a deep copy to prevent modification of internal state
   */
  public async getOrCreateAgentEntityState(
    agentId: AgentId,
    type: EntityType,
    id: EntityId
  ): Promise<AgentEntityState> {
    const agentData = this.database.agents[agentId];
    if (!agentData) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const entityKey = `${type}:${id}` as unknown as EntityId;

    if (!agentData.entityStates[entityKey]) {
      const newEntityState: AgentEntityState = {
        agentId: agentId,
        targetType: type,
        targetId: id,
        memories: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      agentData.entityStates[entityKey] = newEntityState;
    }

    // Important: Return a deep copy to prevent external modification
    return createDeepCopy(agentData.entityStates[entityKey]);
  }

  /**
   * Get or create multiple agent entity states
   * Returns deep copies to prevent modification of internal state
   */
  public async getOrCreateAgentEntityStates(
    agentIds: AgentId[],
    targetAgentIds: AgentId[],
    targetUserIds: UserId[]
  ): Promise<Record<AgentId, AgentEntityState[]>> {
    const result: Record<AgentId, AgentEntityState[]> = {};

    for (const agentId of agentIds) {
      result[agentId] = [];

      for (const targetAgentId of targetAgentIds) {
        const entityState = await this.getOrCreateAgentEntityState(
          agentId,
          EntityType.Agent,
          targetAgentId
        );
        result[agentId].push(entityState);
      }

      for (const targetUserId of targetUserIds) {
        const entityState = await this.getOrCreateAgentEntityState(
          agentId,
          EntityType.User,
          targetUserId
        );
        result[agentId].push(entityState);
      }
    }

    return result;
  }

  /**
   * Update an agent's memory at specific index or add new memory
   * Uses deep copy to ensure data safety
   */
  public async updateAgentStateMemory(
    agentId: AgentId,
    index: number,
    memory: string,
    createdAt?: Date
  ): Promise<void> {
    const agentData = this.database.agents[agentId];
    if (!agentData) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const state = agentData.state;
    const timestamp = createdAt || new Date();

    const memoryObj = {
      memory: memory,
      createdAt: timestamp,
    } as unknown as AgentMemory;

    if (index >= 0 && index < state.memories.length) {
      // Important: Use deep copy to ensure memory doesn't reference external data
      state.memories[index] = createDeepCopy(memoryObj);
    } else if (index === state.memories.length) {
      state.memories.push(createDeepCopy(memoryObj));
    } else {
      throw new Error(`Invalid memory index ${index}`);
    }

    state.updatedAt = new Date();
    await this.saveState(agentId);
  }

  /**
   * Update an agent's memory about a specific entity
   * Uses deep copy to ensure data safety
   */
  public async updateAgentEntityStateMemory(
    agentId: AgentId,
    targetType: EntityType,
    targetId: EntityId,
    index: number,
    memory: string,
    createdAt?: Date
  ): Promise<void> {
    // Get entity state key
    const entityKey = `${targetType}:${targetId}` as unknown as EntityId;
    const agentData = this.database.agents[agentId];
    if (!agentData) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Ensure entity state exists
    await this.getOrCreateAgentEntityState(agentId, targetType, targetId);

    const entityState = agentData.entityStates[entityKey];
    const timestamp = createdAt || new Date();

    const memoryObj = {
      memory: memory,
      createdAt: timestamp,
    } as unknown as AgentMemory;

    if (index >= 0 && index < entityState.memories.length) {
      // Important: Use deep copy to ensure memory doesn't reference external data
      entityState.memories[index] = createDeepCopy(memoryObj);
    } else {
      entityState.memories.push(createDeepCopy(memoryObj));
    }

    entityState.updatedAt = new Date();
    await this.saveState(agentId);
  }

  /**
   * Update an agent's summary text
   */
  public async updateAgentStateSummary(
    agentId: AgentId,
    summary: string
  ): Promise<void> {
    const agentData = this.database.agents[agentId];
    if (!agentData) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    agentData.state.summary = summary;
    agentData.state.updatedAt = new Date();
    await this.saveState(agentId);
  }
}
