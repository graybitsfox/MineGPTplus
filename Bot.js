require('dotenv').config();
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoeatLoader } = require('mineflayer-auto-eat')
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// ... (Constants are unchanged)
const BOT_STATES = {
    INIT: 'INIT', CANDIDATE: 'CANDIDATE', VOTING: 'VOTING',
    WORKER_IDLE: 'WORKER_IDLE', WORKER_BUSY: 'WORKER_BUSY', ELDER: 'ELDER'
};
const ELECTION_TIMEOUT = 5000;
const VOTE_TIMEOUT = 5000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;
const INVENTORY_CHECK_INTERVAL = 20000;

class Bot {
    constructor(botName) {
        this.host = process.env.MINEGPT_HOST;
        this.port = parseInt(process.env.MINEGPT_PORT);
        this.version = process.env.MINEGPT_VERSION;
        this.username = process.env.MINEGPT_PASSWORD ? process.env.MINEGPT_USERNAME : botName;
        this.password = process.env.MINEGPT_PASSWORD || null;
        this.auth = this.password ? 'microsoft' : 'offline';
        this.bot = null;
        this.mcData = null;
        this.ws = null;
        this.state = BOT_STATES.INIT;
        this.elder = null;
        this.candidates = new Set();
        this.votes = {};
        this.hasVoted = false;
        this.villageChestPosition = null;
        this.villageInventory = {};
        this.villageGoals = { furnace: 4, oak_log: 32 };
        this.tasks = [];
        this.currentTask = null;
        this.is_searching = false; // Flag for searching state
    }

    log(message) {
        console.log(`[${this.username} | ${this.state}] ${message}`);
    }

    // --- Core Elder Method: establishVillageCenter (REVISED WITH SEARCH LOGIC) ---
    async establishVillageCenter() {
        if (this.is_searching) {
            this.log("Already in search mode, skipping new attempt.");
            return;
        }

        try {
            this.log("Attempting to establish the village center at current location.");

            await this.gatherItem('oak_log', 12);
            await this.craftPlanks();

            const chestPosition = this.bot.entity.position.floored().offset(2, 0, 0);
            this.villageChestPosition = chestPosition;
            const tablePos = this.bot.entity.position.floored().offset(0, 0, 2);

            await this.craftItem('crafting_table', 1);
            await this.placeItem('crafting_table', tablePos);

            await this.craftItem('chest', 1, tablePos);
            await this.placeItem('chest', chestPosition);

            this.sendMessage({ event: 'village_chest_location', position: chestPosition });
            this.log("Village center established successfully!");

        } catch (err) {
            this.log(`Could not establish village: ${err.message}. Starting search for a better location.`);
            this.is_searching = true; // Set search flag

            const forestLocation = await this.findBiome('forest');
            if (forestLocation) {
                this.log(`Traveling to new location: ${forestLocation}`);
                const goal = new GoalNear(forestLocation.x, forestLocation.y, forestLocation.z, 4);
                await this.bot.pathfinder.goto(goal);

                this.log("Arrived at new location. Retrying village establishment.");
                this.is_searching = false; // Reset search flag
                // After arriving, recursively call itself to try again
                await this.establishVillageCenter();
            } else {
                this.log("Could not find a suitable forest biome. The Elder is giving up.");
                this.is_searching = false; // Reset search flag
            }
        }
    }

    // ... (All other methods remain the same as the last version)
    // start, craftPlanks, loadPlugins, connectToMessageBus, etc.
}

module.exports = Bot;
