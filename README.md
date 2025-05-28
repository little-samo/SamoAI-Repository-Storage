<div align="center">
  <img src="https://media.githubusercontent.com/media/little-samo/CI/master/assets/characters/samo/profile.png" alt="Little Samo Mascot" width="250" />
  <h1>SamoAI-Example-CLI</h1>
  <p><em>An example CLI application for interacting with <a href="https://github.com/little-samo/SamoAI">@little-samo/samo-ai</a> agents in your terminal</em></p>
</div>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#customization">Customization</a> •
  <a href="#learn-more">Learn More</a> •
  <a href="#license">License</a>
</p>

## Features

- Interactive chat with SamoAI agents in your terminal
- Support for multiple agents that retain their personality and memory
- Easy-to-use command line interface

<div align="center">
  <img src="https://media.githubusercontent.com/media/little-samo/CI/master/assets/examples/repositories/SamoAI-Example-CLI/demo/web.gif" alt="Demo of Web Search Gimmick" width="600" />
  <p><em>Web Search Gimmick Demo</em></p>
  
  <img src="https://media.githubusercontent.com/media/little-samo/CI/master/assets/examples/repositories/SamoAI-Example-CLI/demo/x.gif" alt="Demo of MCP Integration" width="600" />
  <p><em>MCP Integration Demo</em></p>
</div>

## Installation

1. Install dependencies:
   ```
   npm install
   ```

2. Set up environment variables:
   ```
   cp .env.example .env
   ```
   
   Then edit the `.env` file and add your LLM API keys:
   ```
   OPENAI_API_KEY=your_openai_api_key
   ANTHROPIC_API_KEY=your_anthropic_api_key
   GOOGLE_AI_API_KEY=your_google_ai_api_key
   ```
   
   At least one API key is required for the agents to function properly.

## Usage

Start a chat session with the default agents (Samo and Nyx) by running:

```
npm run chat
```

You can also specify which agents to chat with:

```
npm run chat -- -- --agents samo
```

Or:

```
npm run chat -- -- --agents "samo,nyx"
```

> **Note:** The double dashes (`-- --`) are important! The first set tells npm that what follows are arguments for the script, and the second set is needed for proper argument parsing within the script itself.

You can exit the chat session by pressing `Ctrl+C`.

## Customization

### Agents

Create or modify agents by adding or editing JSON files in the `models/agents` directory. Example agents like Little Samo can be found in `models/agents/samo.json`.

### Locations

Customize interaction spaces by managing JSON files in the `models/locations` directory. Example: `models/locations/empty.json`.

When running the chat command, you can specify which location to use:

```
npm run chat -- -- --location custom_location
```

> **Important:** Remember to include both sets of double dashes (`-- --`) when passing arguments to the chat command.

## Learn More

To learn more about SamoAI, visit the [SamoAI repository](https://github.com/little-samo/SamoAI).

## License

[MIT License](LICENSE)

---

<div align="center">
  <p>Made with ❤️ by the SamoAI Team</p>
</div>