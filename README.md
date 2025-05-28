<div align="center">
  <img src="https://media.githubusercontent.com/media/little-samo/CI/master/assets/characters/samo/profile.png" alt="Little Samo Mascot" width="250" />
  <h1>SamoAI Repository Storage</h1>
  <p><em>File system-based repository implementations for <a href="https://github.com/little-samo/SamoAI">@little-samo/samo-ai</a></em></p>
</div>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#file-structure">File Structure</a> •
  <a href="#learn-more">Learn More</a> •
  <a href="#license">License</a>
</p>

## Features

- File system-based storage for SamoAI entities
- Persistent memory and state management
- Support for agents, users, locations, items, and gimmicks
- TypeScript support with full type safety

## Installation

Install the package using npm:

```bash
npm install @little-samo/samo-ai-repository-storage
```

Or using yarn:

```bash
yarn add @little-samo/samo-ai-repository-storage
```

## Usage

### Basic Setup

```typescript
import {
  AgentStorage,
  UserStorage,
  LocationStorage,
  ItemStorage,
  GimmickStorage
} from '@little-samo/samo-ai-repository-storage';
import { WorldManager } from '@little-samo/samo-ai';

// Initialize storage instances
const agentStorage = new AgentStorage(
  './models/agents',    // Path to agent model files
  './states/agents'     // Path to agent state files
);

const userStorage = new UserStorage(
  './models/users',
  './states/users'
);

const locationStorage = new LocationStorage(
  './models/locations',
  './states/locations'
);

const itemStorage = new ItemStorage(
  './states/items'      // Only state path needed for items
);

const gimmickStorage = new GimmickStorage(
  './states/gimmicks'   // Only state path needed for gimmicks
);

// Initialize with existing data
await agentStorage.initialize(['samo', 'nyx']); // Load samo.json and nyx.json
await userStorage.initialize(['lucid']); // Load lucid.json
await locationStorage.initialize(['empty']);
await itemStorage.initialize(['agent:1', 'user:1']); // Initialize inventories
await gimmickStorage.initialize([1]); // Initialize gimmicks for location

// Initialize WorldManager with all repositories
WorldManager.initialize({
  agentRepository: agentStorage,
  gimmickRepository: gimmickStorage,
  itemRepository: itemStorage,
  locationRepository: locationStorage,
  userRepository: userStorage,
});
```

## File Structure

The storage system expects the following directory structure:

```
your-project/
├── models/
│   ├── agents/
│   │   ├── samo.json
│   │   └── nyx.json
│   ├── users/
│   │   └── lucid.json
│   └── locations/
│       └── empty.json
└── states/
    ├── agents/
    │   ├── samo.json
    │   └── nyx.json
    ├── users/
    │   └── lucid.json
    ├── locations/
    │   └── empty.json
    ├── items/
    │   ├── items_agent_1.json
    │   └── items_user_1.json
    └── gimmicks/
        └── gimmicks_1.json
```

- **models/**: Static entity definitions (agents, users, locations only) - **Must be created manually**
- **states/**: Dynamic runtime data that changes during execution - **Created automatically if missing**
- **items/**: Inventory data per entity (format: `items_{entityType}_{entityId}.json`)
- **gimmicks/**: Gimmick states per location (format: `gimmicks_{locationId}.json`)

**Note**: Items and gimmicks don't have model files - they are created and managed entirely through the state files. The `states/` directories will be automatically created during initialization if they don't exist.

## Learn More

- [SamoAI Core Library](https://github.com/little-samo/SamoAI) - The main SamoAI framework
- [SamoAI Example CLI](https://github.com/little-samo/SamoAI-Example-CLI) - Example implementation using this storage library

## License

[MIT License](LICENSE)

---

<div align="center">
  <p>Made with ❤️ by the SamoAI Team</p>
</div>