import * as fs from 'fs/promises';
import * as path from 'path';

import {
  LlmApiKeyModel,
  LlmPlatform,
  UserId,
  UserModel,
  UserRepository,
  UserState,
  sleep,
} from '@little-samo/samo-ai';
import {
  createDeepCopy,
  fileExists,
  ensureDirectoryExists,
} from '@little-samo/samo-ai-repository-storage/utils';

/**
 * Data structure for user information including model and state
 */
interface UserData {
  model: UserModel;
  modelPath: string;
  state: UserState;
  statePath: string;
}

/**
 * Database structure for storing multiple users
 */
interface UserDatabase {
  users: Record<UserId, UserData>;
}

/**
 * Storage service for user data with persistence to filesystem
 * Manages user models, states, and API keys with file-based persistence
 */
export class UserStorage implements UserRepository {
  private database: UserDatabase = {
    users: {},
  };

  private saveInProgress: boolean = false;
  private saveQueue: Map<
    UserId,
    { timeoutId: NodeJS.Timeout; resolve: () => void }
  > = new Map();
  private saveQueueDelay: number = 50;

  public constructor(
    private readonly modelsBasePath: string,
    private readonly statesBasePath: string
  ) {}

  /**
   * Initialize user data from model files
   * @param modelBaseNames Base names of user model files to load
   */
  public async initialize(modelBaseNames: string[]): Promise<UserStorage> {
    // Ensure states directory exists
    await ensureDirectoryExists(this.statesBasePath);

    const loadPromises = modelBaseNames.map((baseName) =>
      this.loadUserData(`${baseName}.json`)
    );

    await Promise.all(loadPromises);

    return this;
  }

  /**
   * Load user data from model and state files
   * @param filename The filename of the user model
   */
  private async loadUserData(filename: string): Promise<void> {
    const modelPath = path.join(this.modelsBasePath, filename);

    if (!(await fileExists(modelPath))) {
      throw new Error(`User model file not found: ${modelPath}`);
    }

    const statePath = path.join(this.statesBasePath, filename);

    const modelContent = await fs.readFile(modelPath, 'utf-8');
    const modelJson = JSON.parse(modelContent);

    const userId = Number(modelJson.id) as UserId;
    this.database.users[userId] = {
      model: modelJson,
      modelPath,
      state: {
        userId: userId,
      },
      statePath,
    };

    if (await fileExists(statePath)) {
      try {
        const stateContent = await fs.readFile(statePath, 'utf-8');
        const stateData = JSON.parse(stateContent);

        this.database.users[userId].state = stateData.state || {
          userId: userId,
        };
      } catch (error) {
        console.warn(
          `Failed to load user state file ${statePath}, using default state:`,
          error
        );
      }
    }
  }

  /**
   * Get list of all user IDs currently stored
   * @returns Array of user IDs
   */
  public getUserIds(): UserId[] {
    return Object.keys(this.database.users).map((id) => Number(id) as UserId);
  }

  /**
   * Queue state save operation with debouncing
   * @param userId The user ID to save state for
   */
  private async saveState(userId: UserId): Promise<void> {
    if (this.saveQueue.has(userId)) {
      // Resolve previous promise when clearing timeout
      const queueItem = this.saveQueue.get(userId)!;
      clearTimeout(queueItem.timeoutId);
      queueItem.resolve(); // Resolve the previous promise
    }

    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(async () => {
        try {
          await this.executeSave(userId);
          this.saveQueue.delete(userId);
          resolve();
        } catch (error) {
          console.error(`Error saving state for user ${userId}:`, error);
          this.saveQueue.delete(userId);
          resolve();
        }
      }, this.saveQueueDelay);

      // Store both the timeout ID and the resolve function
      this.saveQueue.set(userId, { timeoutId, resolve });
    });
  }

  /**
   * Execute the actual save operation to filesystem
   * Uses a lock to prevent concurrent writes
   */
  private async executeSave(userId: UserId): Promise<void> {
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

      const userData = this.database.users[userId];
      if (!userData) {
        throw new Error(`User not found: ${userId}`);
      }

      const stateData = {
        state: userData.state,
      };

      const stateJson = JSON.stringify(stateData, null, 2);
      await fs.writeFile(userData.statePath, stateJson);
    } finally {
      this.saveInProgress = false;
    }
  }

  /**
   * Get user model by ID
   * Returns a deep copy to prevent modification of internal state
   */
  public async getUserModel(userId: UserId): Promise<UserModel> {
    const userData = this.database.users[userId];
    if (!userData) {
      throw new Error(`User not found: ${userId}`);
    }

    // Important: Return a deep copy to prevent external modification of stored data
    return createDeepCopy(userData.model);
  }

  /**
   * Get multiple user models by IDs
   * Returns deep copies to prevent modification of internal state
   */
  public async getUserModels(
    userIds: UserId[]
  ): Promise<Record<UserId, UserModel>> {
    const result: Record<UserId, UserModel> = {};
    for (const userId of userIds) {
      result[userId] = await this.getUserModel(userId);
    }
    return result;
  }

  /**
   * Create a new user model with the specified parameters
   * @param userId The unique identifier for the user
   * @param options Optional parameters including username, nickname, firstName, lastName, and meta
   * @returns The created UserModel
   */
  public async createUserModel(
    userId: UserId,
    nickname: string,
    options?: {
      username?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      meta?: Record<string, unknown>;
    }
  ): Promise<UserModel> {
    // Check if user already exists
    if (this.database.users[userId]) {
      throw new Error(`User with ID ${userId} already exists`);
    }

    const userModel: UserModel = {
      id: userId,
      username: options?.username ?? null,
      nickname,
      firstName: options?.firstName ?? null,
      lastName: options?.lastName ?? null,
      meta: options?.meta ?? {},
    };

    // Create the model file path
    const modelPath = path.join(this.modelsBasePath, `${userId}.json`);
    const statePath = path.join(this.statesBasePath, `${userId}.json`);

    // Initialize user data in memory
    this.database.users[userId] = {
      model: userModel,
      modelPath,
      state: {
        userId: userId,
      },
      statePath,
    };

    // Save the model to file
    const modelJson = JSON.stringify(userModel, null, 2);
    await fs.writeFile(modelPath, modelJson);

    // Return a deep copy to prevent external modification
    return createDeepCopy(userModel);
  }

  /**
   * Returns LLM API keys from environment variables
   * In a full implementation, each user would have their own API keys
   */
  public async getUserLlmApiKeys(_userId: UserId): Promise<LlmApiKeyModel[]> {
    // Uses shared API keys from .env regardless of user ID
    // A real implementation would store and retrieve user-specific API keys
    return [
      {
        id: 1,
        platform: LlmPlatform.OPENAI,
        key: process.env.OPENAI_API_KEY!,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 2,
        platform: LlmPlatform.GEMINI,
        key: process.env.GEMINI_API_KEY!,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 3,
        platform: LlmPlatform.ANTHROPIC,
        key: process.env.ANTHROPIC_API_KEY!,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
  }

  /**
   * Get or create user state
   * Returns a deep copy to prevent modification of internal state
   */
  public async getOrCreateUserState(userId: UserId): Promise<UserState> {
    if (!this.database.users[userId]) {
      throw new Error(`User not found: ${userId}`);
    }
    // Important: Return a deep copy to ensure state is not modified externally
    return createDeepCopy(this.database.users[userId].state);
  }

  /**
   * Get or create multiple user states
   * Returns deep copies to prevent modification of internal state
   */
  public async getOrCreateUserStates(
    userIds: UserId[]
  ): Promise<Record<UserId, UserState>> {
    const result: Record<UserId, UserState> = {};
    for (const userId of userIds) {
      result[userId] = await this.getOrCreateUserState(userId);
    }
    return result;
  }
}
