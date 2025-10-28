require('dotenv').config();
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
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
const TASK_CHUNK_SIZE = 16; // How much of a task a single bot will take on at once


class Bot {
    // ... (Constructor is unchanged)
    constructor(botName) {
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
        this.villageGoals = { furnace: 4, oak_log: 64 }; // Increased goal for testing teamwork
        this.tasks = [];
        this.currentTask = null;
        this.is_searching = false;
    }

    log(message) {
        console.log(`[${this.botName} | ${this.state}] ${message}`);
    }

    // --- Task Logic (REWRITTEN FOR TEAMWORK) ---

    // ELDER: Creates a task with a total required amount.
    createNewTask(type, details, goal) {
        const task = {
            id: uuidv4(),
            type,
            goal,
            details: {
                itemName: details.itemName,
                required: details.count, // Total amount needed
                progress: 0, // How much has been completed
            },
            assignedWorkers: new Set(),
        };
        this.tasks.push(task);
        this.log(`Created new shared task for goal '${goal}': Gather ${details.count} ${details.itemName}`);
    }

    // ELDER: Handles messages from workers
    handleMessage(data) {
        // ... (election logic is the same)
        if (this.state === BOT_STATES.ELDER) {
            const task = this.tasks.find(t => t.id === data.taskId);
            if (!task) return;

            if (data.event === 'task_progress') {
                task.progress += data.amount;
                this.log(`Progress on task ${task.id}: ${task.progress}/${task.details.required} of ${task.details.itemName}`);
                if (task.progress >= task.details.required) {
                    this.log(`Task ${task.id} is complete!`);
                    this.tasks = this.tasks.filter(t => t.id !== task.id);
                    // Check inventory, which will then re-evaluate goals
                    this.checkVillageInventory();
                }
            }
        }
        // ... (worker message handling is the same)
    }

    // WORKER: Accepts a "chunk" of a task
    acceptTask(task) {
        this.state = BOT_STATES.WORKER_BUSY;

        const remaining = task.details.required - task.details.progress;
        const amountToTake = Math.min(remaining, TASK_CHUNK_SIZE);

        this.currentTask = {
            id: task.id,
            type: task.type,
            details: {
                itemName: task.details.itemName,
                count: amountToTake, // Only take a chunk
            }
        };

        this.log(`Accepting a chunk of task ${task.id}: Gather ${amountToTake} ${task.details.itemName}`);
        // No need to inform the Elder that we've accepted, just report progress.
        this.executeTask();
    }

    // WORKER: Executes the task chunk and reports progress
    async executeTask() {
        try {
            const { type, details } = this.currentTask;
            if (type === 'gather') {
                await this.gatherItem(details.itemName, details.count);
                await this.depositItems(details.itemName, details.count);
                // Report progress to the Elder
                this.sendMessage({
                    event: 'task_progress',
                    taskId: this.currentTask.id,
                    amount: details.count
                });
            } else if (type === 'craft') {
                // Crafting tasks are not chunked for now, one bot does it all
                await this.craftAndDepositItem(details.itemName, details.count);
                 this.sendMessage({
                    event: 'task_progress',
                    taskId: this.currentTask.id,
                    amount: details.count
                });
            }
            this.log(`Finished my chunk of task ${this.currentTask.id}.`);
        } catch (err) {
            this.log(`Error on my chunk of task ${this.currentTask.id}: ${err.message}. Abandoning chunk.`);
            // Don't report failure, just become idle. Another bot might succeed.
        } finally {
            this.currentTask = null;
            this.state = BOT_STATES.WORKER_IDLE;
        }
    }

    // ... (The rest of the file is the same as the previous version)
}

module.exports = Bot;
