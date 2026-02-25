import * as fs from 'fs/promises';
import * as path from 'path';

import {
  ItemDataId,
  ItemRepository,
  ItemModel,
  EntityKey,
  EntityType,
  AgentId,
  UserId,
  ItemId,
} from '@little-samo/samo-ai';
import {
  createDeepCopy,
  fileExists,
  ensureDirectoryExists,
} from '@little-samo/samo-ai-repository-storage/utils';

/**
 * Data structure for owner's inventory
 */
interface OwnerInventory {
  items: Map<ItemId, ItemModel>;
  statePath: string;
}

/**
 * Database structure for storing items across all owners
 */
interface ItemDatabase {
  inventories: Map<EntityKey, OwnerInventory>;
}

/**
 * Storage service for item data with persistence to filesystem
 * Manages item inventories, creation, transfers, and removal
 */
export class ItemStorage implements ItemRepository {
  private database: ItemDatabase = {
    inventories: new Map(),
  };

  private savePromise: Promise<void> = Promise.resolve();
  private saveQueue: Map<
    EntityKey,
    { timeoutId: NodeJS.Timeout; resolve: () => void }
  > = new Map();
  private saveQueueDelay: number = 50;
  private nextItemId: number = 1;

  public constructor(private readonly statesBasePath: string) {}

  /**
   * Initialize item data for specific entity owners
   * @param entityKeys Array of entity keys to initialize
   */
  public async initialize(entityKeys: EntityKey[]): Promise<ItemStorage> {
    // Ensure states directory exists
    await ensureDirectoryExists(this.statesBasePath);

    const loadPromises = entityKeys.map((entityKey) =>
      this.loadOwnerInventory(entityKey)
    );

    await Promise.all(loadPromises);

    // Find the highest item ID to continue from
    let maxId = 0;
    for (const ownerData of this.database.inventories.values()) {
      for (const item of ownerData.items.values()) {
        const itemId = Number(item.id);
        if (itemId > maxId) {
          maxId = itemId;
        }
      }
    }
    this.nextItemId = maxId + 1;

    return this;
  }

  /**
   * Parse entity key into agentId and userId
   */
  private parseEntityKey(entityKey: EntityKey): {
    agentId: bigint | null;
    userId: bigint | null;
  } {
    const [ownerType, ownerId] = entityKey.split(':');
    if (ownerType === EntityType.Agent) {
      return { agentId: BigInt(ownerId), userId: null };
    } else if (ownerType === EntityType.User) {
      return { agentId: null, userId: BigInt(ownerId) };
    } else {
      throw new Error(`Invalid owner type: ${ownerType}`);
    }
  }

  /**
   * Load inventory data for a specific entity owner from state file
   */
  private async loadOwnerInventory(entityKey: EntityKey): Promise<void> {
    const statePath = path.join(
      this.statesBasePath,
      `items_${entityKey.replace(':', '_')}.json`
    );

    this.database.inventories.set(entityKey, {
      items: new Map(),
      statePath,
    });

    try {
      if (await fileExists(statePath)) {
        const stateContent = await fs.readFile(statePath, 'utf-8');
        const stateData = JSON.parse(stateContent);

        this.database.inventories.get(entityKey)!.items =
          stateData.items || new Map();
      }
    } catch (error) {
      console.warn(
        `Failed to load item state file ${statePath}, using default state:`,
        error
      );
    }
  }

  /**
   * Queue state save operation with debouncing
   */
  private async saveState(entityKey: EntityKey): Promise<void> {
    if (this.saveQueue.has(entityKey)) {
      const queueItem = this.saveQueue.get(entityKey)!;
      clearTimeout(queueItem.timeoutId);
      queueItem.resolve();
    }

    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(async () => {
        this.saveQueue.delete(entityKey);
        try {
          await this.executeSave(entityKey);
        } catch (error) {
          console.error(
            `Error saving item states for entity ${entityKey}:`,
            error
          );
        } finally {
          resolve();
        }
      }, this.saveQueueDelay);

      this.saveQueue.set(entityKey, { timeoutId, resolve });
    });
  }

  /**
   * Execute the actual save operation to filesystem
   * Uses a promise chain to prevent concurrent writes
   */
  private async executeSave(entityKey: EntityKey): Promise<void> {
    const saveOperation = this.savePromise.then(async () => {
      const ownerData = this.database.inventories.get(entityKey);
      if (!ownerData) {
        throw new Error(`Entity inventory not found: ${entityKey}`);
      }

      const stateData = { items: Object.fromEntries(ownerData.items) };
      const stateJson = JSON.stringify(stateData, null, 2);
      await ensureDirectoryExists(this.statesBasePath);
      await fs.writeFile(ownerData.statePath, stateJson);
    });

    this.savePromise = saveOperation.catch(() => {});
    await saveOperation;
  }

  /**
   * Ensure entity inventory exists in memory
   */
  private async ensureEntityExists(entityKey: EntityKey): Promise<void> {
    if (!this.database.inventories.has(entityKey)) {
      await this.loadOwnerInventory(entityKey);
    }
  }

  /**
   * Get items owned by entities
   */
  public async getEntityItemModels(
    agentIds: AgentId[],
    userIds: UserId[]
  ): Promise<Record<EntityKey, ItemModel[]>> {
    const result: Record<EntityKey, ItemModel[]> = {};

    // Process agent inventories
    for (const agentId of agentIds) {
      const entityKey = `${EntityType.Agent}:${agentId}` as EntityKey;
      await this.ensureEntityExists(entityKey);

      const ownerData = this.database.inventories.get(entityKey);
      result[entityKey] = ownerData
        ? Object.values(ownerData.items).map((item) =>
            createDeepCopy(item as ItemModel)
          )
        : [];
    }

    // Process user inventories
    for (const userId of userIds) {
      const entityKey = `${EntityType.User}:${userId}` as EntityKey;
      await this.ensureEntityExists(entityKey);

      const ownerData = this.database.inventories.get(entityKey);
      result[entityKey] = ownerData
        ? Object.values(ownerData.items).map((item) =>
            createDeepCopy(item as ItemModel)
          )
        : [];
    }

    return result;
  }

  /**
   * Create a new item for an owner
   */
  public async createItemModel(
    ownerEntityKey: EntityKey,
    dataId: ItemDataId,
    count: number
  ): Promise<ItemModel> {
    if (count <= 0) {
      throw new Error('Item count must be greater than 0');
    }

    await this.ensureEntityExists(ownerEntityKey);

    const ownerData = this.database.inventories.get(ownerEntityKey);
    const itemId = (this.nextItemId++).toString() as ItemId;

    const { agentId, userId } = this.parseEntityKey(ownerEntityKey);
    const newItem: ItemModel = {
      id: itemId,
      itemDataId: dataId,
      ownerAgentId: agentId,
      ownerUserId: userId,
      count,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    ownerData!.items.set(itemId, newItem);
    await this.saveState(ownerEntityKey);

    return createDeepCopy(newItem as ItemModel);
  }

  /**
   * Add to existing item count or create new item
   */
  public async addOrCreateItemModel(
    ownerEntityKey: EntityKey,
    dataId: ItemDataId,
    count: number,
    _options?: {
      reason?: string;
    }
  ): Promise<ItemModel> {
    if (count <= 0) {
      throw new Error('Item count must be greater than 0');
    }

    await this.ensureEntityExists(ownerEntityKey);

    const ownerData = this.database.inventories.get(ownerEntityKey)!;

    // Check if owner already has this item type
    for (const item of ownerData.items.values()) {
      if (item.itemDataId === dataId) {
        item.count += count;
        item.updatedAt = new Date();
        await this.saveState(ownerEntityKey);
        return createDeepCopy(item as ItemModel);
      }
    }

    // Create new item if not found
    return this.createItemModel(ownerEntityKey, dataId, count);
  }

  /**
   * Remove items from an owner's inventory
   */
  public async removeItemModel(
    ownerEntityKey: EntityKey,
    item: ItemModel,
    count: number,
    _options?: {
      reason?: string;
      force?: boolean;
    }
  ): Promise<void> {
    if (count <= 0) {
      throw new Error('Remove count must be greater than 0');
    }

    await this.ensureEntityExists(ownerEntityKey);

    const ownerData = this.database.inventories.get(ownerEntityKey)!;
    const itemInstance = ownerData.items.get(item.id as ItemId);

    if (!itemInstance) {
      throw new Error(
        `Item with id ${item.id} not found in ${ownerEntityKey} inventory`
      );
    }

    if (itemInstance.count < count) {
      throw new Error(
        `Cannot remove ${count} items, only ${itemInstance.count} available`
      );
    }

    itemInstance.count -= count;
    itemInstance.updatedAt = new Date();

    // Remove item entirely if count reaches 0
    if (itemInstance.count === 0) {
      ownerData.items.delete(item.id as ItemId);
    }

    await this.saveState(ownerEntityKey);
  }

  /**
   * Transfer items between owners
   */
  public async transferItemModel(
    ownerEntityKey: EntityKey,
    item: ItemModel,
    targetEntityKey: EntityKey,
    count: number,
    _options?: {
      reason?: string;
      force?: boolean;
    }
  ): Promise<void> {
    if (count <= 0) {
      throw new Error('Transfer count must be greater than 0');
    }

    await this.ensureEntityExists(ownerEntityKey);
    await this.ensureEntityExists(targetEntityKey);

    const ownerData = this.database.inventories.get(ownerEntityKey)!;
    const itemInstance = ownerData.items.get(item.id as ItemId);

    if (!itemInstance) {
      throw new Error(
        `Item with id ${item.id} not found in ${ownerEntityKey} inventory`
      );
    }

    if (itemInstance.count < count) {
      throw new Error(
        `Cannot transfer ${count} items, only ${itemInstance.count} available`
      );
    }

    // Remove from source owner
    await this.removeItemModel(ownerEntityKey, item, count);

    // Add to target owner
    await this.addOrCreateItemModel(
      targetEntityKey,
      item.itemDataId as ItemDataId,
      count
    );
  }

  /**
   * Get all items owned by a specific entity key
   */
  public async getEntityItems(entityKey: EntityKey): Promise<ItemModel[]> {
    await this.ensureEntityExists(entityKey);

    const ownerData = this.database.inventories.get(entityKey);
    if (!ownerData) {
      return [];
    }

    return Object.values(ownerData.items).map((item) =>
      createDeepCopy(item as ItemModel)
    );
  }

  /**
   * Check if an entity owns a specific item
   */
  public async entityOwnsItem(
    entityKey: EntityKey,
    itemId: number
  ): Promise<boolean> {
    await this.ensureEntityExists(entityKey);

    const ownerData = this.database.inventories.get(entityKey);
    return ownerData ? ownerData.items.has(itemId as ItemId) : false;
  }

  /**
   * Get total count of a specific item type owned by an entity
   */
  public async getEntityItemCount(
    entityKey: EntityKey,
    dataId: ItemDataId
  ): Promise<number> {
    await this.ensureEntityExists(entityKey);

    const ownerData = this.database.inventories.get(entityKey);
    if (!ownerData) {
      return 0;
    }

    let totalCount = 0;
    for (const item of ownerData.items.values()) {
      if (item.itemDataId === dataId) {
        totalCount += item.count;
      }
    }
    return totalCount;
  }

  /**
   * Find an item by id across all owners
   */
  public async findItemById(itemId: number): Promise<ItemModel | null> {
    const itemIdStr = String(itemId);
    for (const ownerData of Object.values(this.database.inventories)) {
      if (ownerData.items[itemIdStr]) {
        return createDeepCopy(ownerData.items[itemIdStr] as ItemModel);
      }
    }
    return null;
  }
}
