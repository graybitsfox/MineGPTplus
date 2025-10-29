require('dotenv').config();
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder') // Added GoalBlock
const { loader: autoeatLoader } = require('mineflayer-auto-eat')
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

// ... (Constants are unchanged)
const BOT_STATES = {
    INIT: 'INIT', CANDIDATE: 'CANDIDATE', VOTING: 'VOTING',
    WORKER_IDLE: 'WORKER_IDLE', WORKER_BUSY: 'WORKER_BUSY', ELDER: 'ELDER'
};
const ELECTION_TIMEOUT = 5000;
const VOTE_TIMEOUT = 5000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;
const INVENTORY_CHECK_INTERVAL = 10000;
const STATE_FILE = path.join(__dirname, 'village_state.json');
const TASK_CHUNK_SIZE = 16;


class Bot {
    constructor(botName) {
        // ...
        this.host = process.env.MINEGPT_HOST;
        this.port = parseInt(process.env.MINEGPT_PORT);
        this.version = process.env.MINEGPT_VERSION;
        this.username = process.env.MINEGPT_PASSWORD ? process.env.MINEGPT_USERNAME : botName;
        this.password = process.env.MINEGPT_PASSWORD || null;
        this.auth = this.password ? 'microsoft' : 'offline';
        this.botName = botName;
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
        this.tasks = [];
        this.currentTask = null;
        this.is_searching = false;

        // --- UPDATED Technology Tree with Construction ---
        this.techLevel = 1;
        this.goalTemplates = {
            1: { furnace: 1 },
            2: { iron_pickaxe: 1 },
            3: { build_warehouse: true } // Level 3: Build a simple warehouse
        };
        this.villageGoals = { ...this.goalTemplates[1] };

        // --- NEW: Blueprint for the warehouse ---
        this.blueprints = {
            warehouse: {
                materials: { oak_planks: 28 }, // 3x3 base, 2 high walls
                schematic: [ // Relative to the chest position
                    // Walls
                    { pos: [-1, 0, -1], type: 'oak_planks' }, { pos: [0, 0, -1], type: 'oak_planks' }, { pos: [1, 0, -1], type: 'oak_planks' },
                    { pos: [-1, 0, 0], type: 'oak_planks' }, /* chest */ { pos: [1, 0, 0], type: 'oak_planks' },
                    { pos: [-1, 0, 1], type: 'oak_planks' }, { pos: [0, 0, 1], type: 'oak_planks' }, { pos: [1, 0, 1], type: 'oak_planks' },

                    { pos: [-1, 1, -1], type: 'oak_planks' }, { pos: [0, 1, -1], type: 'oak_planks' }, { pos: [1, 1, -1], type: 'oak_planks' },
                    { pos: [-1, 1, 0], type: 'oak_planks' }, /* chest */ { pos: [1, 1, 0], type: 'oak_planks' },
                    { pos: [-1, 1, 1], type: 'oak_planks' }, { pos: [0, 1, 1], type: 'oak_planks' }, { pos: [1, 1, 1], type: 'oak_planks' },
                    // Roof
                    { pos: [-1, 2, -1], type: 'oak_planks' }, { pos: [0, 2, -1], type: 'oak_planks' }, { pos: [1, 2, -1], type: 'oak_planks' },
                    { pos: [-1, 2, 0], type: 'oak_planks' }, { pos: [0, 2, 0], type: 'oak_planks' }, { pos: [1, 2, 0], type: 'oak_planks' },
                    { pos: [-1, 2, 1], type: 'oak_planks' }, { pos: [0, 2, 1], type: 'oak_planks' }, { pos: [1, 2, 1], type: 'oak_planks' },
                ]
            }
        };
    }

    // ... log, start, connection logic, etc. is unchanged ...

    // --- Core Logic (Modified for Construction) ---

    evaluateGoals() {
        if (this.state !== BOT_STATES.ELDER) return;
        if (this.checkIfGoalsAreMet()) {
            this.advanceTechLevel();
        }

        for (const goalName in this.villageGoals) {
            const required = this.villageGoals[goalName];

            // --- Construction Goal Logic ---
            if (goalName === 'build_warehouse' && required === true) {
                const blueprint = this.blueprints.warehouse;

                // 1. Check if we have enough materials
                let materialsMet = true;
                for (const material in blueprint.materials) {
                    const requiredAmount = blueprint.materials[material];
                    const currentAmount = this.villageInventory[material] || 0;
                    if (currentAmount < requiredAmount) {
                        materialsMet = false;
                        this.log(`Not enough ${material} for warehouse. Need ${requiredAmount}, have ${currentAmount}`);
                        // Create a sub-goal to gather the missing materials
                        this.evaluateSubGoal(material, requiredAmount - currentAmount, goalName);
                        break;
                    }
                }

                // 2. If materials are met, create build tasks
                if (materialsMet) {
                    this.log("Have enough materials for warehouse. Creating build tasks.");
                    for (const block of blueprint.schematic) {
                         const blockPos = this.villageChestPosition.plus(block.pos);
                         // Check if block is already there
                         if (this.bot.blockAt(blockPos).name !== block.type) {
                            const existingTask = this.tasks.some(t => t.type === 'build' && t.details.position.equals(blockPos));
                            if (!existingTask) {
                                this.createNewTask('build', { position: blockPos, type: block.type }, goalName);
                            }
                         }
                    }
                }
            }
            // --- Regular Item Goal Logic ---
            else {
                // ... (This part is the same as before)
            }
        }
        this.announceTasks();
    }

    async executeTask() {
        try {
            const { type, details } = this.currentTask;
            if (type === 'gather') {
                // ... (same as before)
            } else if (type === 'craft') {
                // ... (same as before)
            } else if (type === 'build') {
                await this.buildBlock(details.position, details.type);
                // For build tasks, progress is 1 block
                this.sendMessage({ event: 'task_progress', taskId: this.currentTask.id, amount: 1 });
            }
        } catch (err) {
            this.log(`Error on task ${this.currentTask.id}: ${err.message}.`);
        } finally {
            this.currentTask = null;
            this.state = BOT_STATES.WORKER_IDLE;
        }
    }

    // --- NEW Worker Method: buildBlock ---
    async buildBlock(position, type) {
        this.log(`Starting to build a ${type} block at ${position}`);

        // 1. Get the required block from the chest
        await this.goToChest();
        const chest = await this.bot.openChest(this.bot.blockAt(this.villageChestPosition));
        const item = this.mcData.itemsByName[type];
        if (!item) throw new Error(`I don't know what a ${type} is.`);

        await chest.withdraw(item.id, null, 1);
        await chest.close();
        this.log(`Withdrew 1x ${type} from the chest.`);

        // 2. Go to the build site
        // We need to find a reference block to place ON. Usually the one below.
        const referenceBlock = this.bot.blockAt(position.offset(0, -1, 0));

        // Pathfind to a spot near the reference block
        await this.bot.pathfinder.goto(new GoalNear(referenceBlock.position.x, referenceBlock.position.y, referenceBlock.position.z, 2));

        // 3. Place the block
        await this.bot.equip(item.id, 'hand');
        await this.bot.placeBlock(referenceBlock, { x: 0, y: 1, z: 0 }); // Place on top of reference

        this.log(`Successfully placed ${type} at ${position}.`);
    }

    // ... (The rest of the file is unchanged)
}

module.exports = Bot;
