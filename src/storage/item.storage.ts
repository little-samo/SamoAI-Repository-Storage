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
  sleep,
} from '@little-samo/samo-ai';

/**
 * Item owner information
 */
interface ItemOwner {
  ownerAgentId: AgentId | null;
  ownerUserId: UserId | null;
}
import {
  createDeepCopy,
  fileExists,
  ensureDirectoryExists,
} from '@little-samo/samo-ai-repository-storage/utils';

/**
 * Extended ItemModel interface with required properties
 */
interface ExtendedItemModel extends ItemModel {
  id: number;
  dataId: ItemDataId;
  owner: ItemOwner;
  count: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Data structure for owner's inventory
 */
interface OwnerInventory {
  items: Record<string, ExtendedItemModel>;
  statePath: string;
}

/**
 * Database structure for storing items across all owners
 */
interface ItemDatabase {
  owners: Record<EntityKey, OwnerInventory>;
}

/**
 * Storage service for item data with persistence to filesystem
 * Manages item inventories, creation, transfers, and removal
 */
export class ItemStorage implements ItemRepository {
  private database: ItemDatabase = {
    owners: {},
  };

  private saveInProgress: boolean = false;
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
    for (const ownerData of Object.values(this.database.owners)) {
      for (const item of Object.values(ownerData.items)) {
        if (item.id > maxId) {
          maxId = item.id;
        }
      }
    }
    this.nextItemId = maxId + 1;

    return this;
  }

  /**
   * Load inventory data for a specific entity owner from state file
   */
  private async loadOwnerInventory(entityKey: EntityKey): Promise<void> {
    const statePath = path.join(
      this.statesBasePath,
      `items_${entityKey.replace(':', '_')}.json`
    );

    this.database.owners[entityKey] = {
      items: {},
      statePath,
    };

    try {
      if (await fileExists(statePath)) {
        const stateContent = await fs.readFile(statePath, 'utf-8');
        const stateData = JSON.parse(stateContent);

        this.database.owners[entityKey].items = stateData.items || {};
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
        try {
          await this.executeSave(entityKey);
          this.saveQueue.delete(entityKey);
          resolve();
        } catch (error) {
          console.error(
            `Error saving item states for entity ${entityKey}:`,
            error
          );
          this.saveQueue.delete(entityKey);
          resolve();
        }
      }, this.saveQueueDelay);

      this.saveQueue.set(entityKey, { timeoutId, resolve });
    });
  }

  /**
   * Execute the actual save operation to filesystem
   */
  private async executeSave(entityKey: EntityKey): Promise<void> {
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

      const ownerData = this.database.owners[entityKey];
      if (!ownerData) {
        throw new Error(`Entity inventory not found: ${entityKey}`);
      }

      const stateData = { items: ownerData.items };
      const stateJson = JSON.stringify(stateData, null, 2);
      await fs.writeFile(ownerData.statePath, stateJson);
    } finally {
      this.saveInProgress = false;
    }
  }

  /**
   * Ensure entity inventory exists in memory
   */
  private async ensureEntityExists(entityKey: EntityKey): Promise<void> {
    if (!this.database.owners[entityKey]) {
      await this.loadOwnerInventory(entityKey);
    }
  }

  /**
   * Get entity key from ItemOwner
   */
  private getEntityKey(owner: ItemOwner): EntityKey {
    if (owner.ownerAgentId !== null) {
      return `${EntityType.Agent}:${owner.ownerAgentId}` as EntityKey;
    } else if (owner.ownerUserId !== null) {
      return `${EntityType.User}:${owner.ownerUserId}` as EntityKey;
    } else {
      throw new Error('ItemOwner must have either ownerAgentId or ownerUserId');
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

      const ownerData = this.database.owners[entityKey];
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

      const ownerData = this.database.owners[entityKey];
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

    const ownerData = this.database.owners[ownerEntityKey];
    const itemId = this.nextItemId++;

    const newItem: ExtendedItemModel = {
      id: itemId,
      dataId,
      owner: { ownerAgentId: null, ownerUserId: null }, // Placeholder for compatibility
      count,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as ExtendedItemModel;

    ownerData.items[String(itemId)] = newItem;
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
    options?: {
      reason?: string;
    }
  ): Promise<ItemModel> {
    if (count <= 0) {
      throw new Error('Item count must be greater than 0');
    }

    await this.ensureEntityExists(ownerEntityKey);

    const ownerData = this.database.owners[ownerEntityKey];

    // Check if owner already has this item type
    for (const item of Object.values(ownerData.items)) {
      if (item.dataId === dataId) {
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
    options?: {
      reason?: string;
      force?: boolean;
    }
  ): Promise<void> {
    if (count <= 0) {
      throw new Error('Remove count must be greater than 0');
    }

    await this.ensureEntityExists(ownerEntityKey);

    const extendedItem = item as ExtendedItemModel;
    const ownerData = this.database.owners[ownerEntityKey];
    const itemIdStr = String(extendedItem.id);
    const itemInstance = ownerData.items[itemIdStr];

    if (!itemInstance) {
      throw new Error(
        `Item with id ${extendedItem.id} not found in ${ownerEntityKey} inventory`
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
      delete ownerData.items[itemIdStr];
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
    options?: {
      reason?: string;
      force?: boolean;
    }
  ): Promise<void> {
    if (count <= 0) {
      throw new Error('Transfer count must be greater than 0');
    }

    await this.ensureEntityExists(ownerEntityKey);
    await this.ensureEntityExists(targetEntityKey);

    const extendedItem = item as ExtendedItemModel;
    const ownerData = this.database.owners[ownerEntityKey];
    const itemIdStr = String(extendedItem.id);
    const itemInstance = ownerData.items[itemIdStr];

    if (!itemInstance) {
      throw new Error(
        `Item with id ${extendedItem.id} not found in ${ownerEntityKey} inventory`
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
    await this.addOrCreateItemModel(targetEntityKey, extendedItem.dataId, count);
  }

  /**
   * Get all items owned by a specific entity key
   */
  public async getEntityItems(entityKey: EntityKey): Promise<ItemModel[]> {
    await this.ensureEntityExists(entityKey);

    const ownerData = this.database.owners[entityKey];
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

    const ownerData = this.database.owners[entityKey];
    return ownerData ? String(itemId) in ownerData.items : false;
  }

  /**
   * Get total count of a specific item type owned by an entity
   */
  public async getEntityItemCount(
    entityKey: EntityKey,
    dataId: ItemDataId
  ): Promise<number> {
    await this.ensureEntityExists(entityKey);

    const ownerData = this.database.owners[entityKey];
    if (!ownerData) {
      return 0;
    }

    let totalCount = 0;
    for (const item of Object.values(ownerData.items)) {
      if (item.dataId === dataId) {
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
    for (const ownerData of Object.values(this.database.owners)) {
      if (ownerData.items[itemIdStr]) {
        return createDeepCopy(ownerData.items[itemIdStr] as ItemModel);
      }
    }
    return null;
  }

  /**
   * Get owner of a specific item by id
   */
  public async getItemOwnerById(itemId: number): Promise<ItemOwner | null> {
    const itemIdStr = String(itemId);
    for (const ownerData of Object.values(this.database.owners)) {
      if (ownerData.items[itemIdStr]) {
        return createDeepCopy(ownerData.items[itemIdStr].owner);
      }
    }
    return null;
  }
}
