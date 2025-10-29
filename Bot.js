require('dotenv').config();
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const autoeat = require('mineflayer-auto-eat')
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { Vec3 } = require('vec3');
const fs = 'fs/promises';
const path = 'path';

// ... (Constants are unchanged)

class Bot {
    constructor(name) {
        this.name = name;
        this.bot = null;
        this.mcData = null;
        this.ws = null;

        // Bot state
        this.role = 'Worker'; // Default role
        this.isLeader = false;
        this.villageState = {};
        this.currentTask = null;
    }

    log(message) {
        console.log(`[${this.name}] ${message}`);
    }

    start() {
        this.log("Attempting to connect to the server...");
        const botOptions = {
            host: process.env.MINEGPT_HOST,
            port: parseInt(process.env.MINEGPT_PORT, 10),
            username: this.name,
            version: process.env.MINEGPT_VERSION,
        };

        // Handle authentication
        if (process.env.MINEGPT_USERNAME && process.env.MINEGPT_PASSWORD) {
            botOptions.username = process.env.MINEGPT_USERNAME;
            botOptions.password = process.env.MINEGPT_PASSWORD;
            botOptions.auth = 'microsoft';
        } else {
            botOptions.auth = 'offline';
        }

        this.bot = mineflayer.createBot(botOptions);

        this.bot.loadPlugin(pathfinder);
        this.bot.loadPlugin(autoeat);


        this.bot.once('spawn', () => {
            this.log('Bot has spawned.');
            this.mcData = require('minecraft-data')(this.bot.version);
            this.bot.autoEat.options.priority = 'foodPoints';
            this.bot.autoEat.options.startAt = 14;
            this.bot.autoEat.options.bannedFood = [];

            const defaultMove = new Movements(this.bot, this.mcData);
            this.bot.pathfinder.setMovements(defaultMove);
            this.log('Pathfinder and auto-eat initialized.');

            // Connect to message bus and start logic after spawn
            // this.connectToMessageBus();
            // this.startElection();
        });

        this.bot.on('kicked', (reason) => {
            this.log(`Kicked from server: ${reason}`);
            process.exit(1);
        });

        this.bot.on('error', (err) => {
            this.log(`An error occurred: ${err.message}`);
        });
    }

    async goToWithTimeout(position, range, timeout = 15000) {
        const goal = new GoalNear(position.x, position.y, position.z, range);

        const pathfinderPromise = this.bot.pathfinder.goto(goal);

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Pathfinding timed out after ${timeout / 1000} seconds!`));
            }, timeout);
        });

        try {
            await Promise.race([pathfinderPromise, timeoutPromise]);
            // If it resolves, clear the timeout to prevent it from rejecting later
        } catch (err) {
            this.bot.pathfinder.stop(); // Stop the pathfinder if it's stuck
            throw err; // Re-throw the timeout error
        }
    }

    async gatherItem(name, count) {
        this.log(`Starting smart search to gather ${count} of ${name}.`);
        const item = this.mcData.itemsByName[name];
        if (!item) throw new Error(`Unknown item name: ${name}`);

        const searchRadii = [64, 128, 256, 512];
        let foundBlocks = [];

        for (const radius of searchRadii) {
            this.log(`Searching for ${name} within ${radius} blocks...`);
            const blocks = await this.bot.findBlocks({
                matching: item.id,
                maxDistance: radius,
                count: count,
            });
            foundBlocks = blocks;
            if (foundBlocks.length >= count) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (foundBlocks.length < count) {
            throw new Error(`Could not find enough ${name} nearby.`);
        }

        this.log(`Found ${foundBlocks.length} blocks of ${name}. Proceeding to gather.`);
        for (let i = 0; i < count; i++) {
            const block = foundBlocks[i];
            if (!block) continue;

            try {
                await this.goToWithTimeout(block.position, 1);

                const currentBlock = this.bot.blockAt(block.position);
                if (currentBlock && currentBlock.type === item.id) {
                    await this.bot.dig(currentBlock);
                    this.log(`Gathered ${i + 1}/${count} of ${name}.`);
                } else {
                    this.log(`Block at ${block.position} is no longer ${name}. Skipping.`);
                }
            } catch (err) {
                this.log(`Could not reach block at ${block.position}: ${err.message}. Skipping this block.`);
                // Try to find a replacement block nearby. If not, just continue.
                const replacement = this.bot.findBlock({ matching: item.id, maxDistance: 32 });
                if(replacement) foundBlocks.push(replacement);
            }
        }

        // --- Universal Crafting: Turn any gathered logs into planks ---
        if (name.endsWith('_log')) {
            const woodType = name.replace('_log', '');
            const plankName = `${woodType}_planks`;
            this.log(`Finished gathering ${name}. Now, attempting to craft ${plankName}.`);
            try {
                // Each log produces 4 planks.
                await this.craftItem(plankName, count * 4);
            } catch (err) {
                this.log(`Could not craft ${plankName}: ${err.message}`);
            }
        }
    }

    async craftItem(itemName, count = 1) {
        this.log(`Attempting to craft ${count} of ${itemName}.`);
        const item = this.mcData.itemsByName[itemName];
        if (!item) {
            throw new Error(`Unknown item name: ${itemName}`);
        }

        const recipes = this.bot.recipesFor(item.id, null, 1, true);
        if (recipes.length === 0) {
            throw new Error(`No crafting recipe found for ${itemName}`);
        }
        const recipe = recipes[0];

        const requiresCraftingTable = recipe.requiresTable;
        let craftingTable = null;
        if (requiresCraftingTable) {
            this.log(`${itemName} requires a crafting table.`);
            craftingTable = this.bot.findBlock({
                matching: this.mcData.blocksByName.crafting_table.id,
                maxDistance: 32
            });

            if (!craftingTable) {
                this.log(`No crafting table found. Attempting to craft and place one.`);
                try {
                    await this.craftItem('crafting_table', 1);
                    this.log(`Successfully crafted a crafting table. Now, let's place it.`);

                    // Find a suitable position to place the table
                    const placePosition = await this.findSuitablePlacePosition();
                    if (!placePosition) {
                        throw new Error("Could not find a suitable position to place the crafting table.");
                    }

                    // Equip the crafting table in hand
                    const tableItem = this.bot.inventory.findInventoryItem(this.mcData.itemsByName.crafting_table.id);
                    if (!tableItem) throw new Error("Could not find the crafted table in inventory.");
                    await this.bot.equip(tableItem, 'hand');

                    // Place the block against the block below it.
                    const referenceBlock = this.bot.blockAt(placePosition.offset(0, -1, 0));
                    await this.bot.placeBlock(referenceBlock, new Vec3(0, 1, 0));
                    this.log(`Successfully placed crafting table at ${placePosition}.`);

                    // Now, find the newly placed table to use it.
                    craftingTable = this.bot.findBlock({
                        matching: this.mcData.blocksByName.crafting_table.id,
                        maxDistance: 8 // Search in a smaller radius around the bot
                    });

                    if (!craftingTable) {
                        throw new Error("Placed a crafting table, but could not find it nearby to use.");
                    }

                } catch (err) {
                    throw new Error(`Could not craft and place a crafting table: ${err.message}`);
                }
            }
        }

        this.log(`Executing recipe for ${itemName}.`);
        try {
            await this.bot.craft(recipe, count, craftingTable);
            this.log(`Successfully crafted ${count} of ${itemName}.`);
        } catch (err) {
            // Log the specific inventory issue if that's the cause
            if (err.message.includes('Can\'t find required items')) {
                this.log('Crafting failed due to missing ingredients. Let\'s check inventory:');
                this.log(this.bot.inventory.items().map(i => `${i.name} x${i.count}`).join(', '));
            }
            throw new Error(`Crafting failed for ${itemName}: ${err.message}`);
        }
    }

    async findSuitablePlacePosition() {
        this.log("Searching for a suitable position to place a block...");
        const bot_position = this.bot.entity.position;

        for (let x = -3; x <= 3; x++) {
            for (let y = -1; y <= 2; y++) {
                for (let z = -3; z <= 3; z++) {
                    const offset = new Vec3(x, y, z);
                    const checkPos = bot_position.plus(offset);
                    const blockAtPos = this.bot.blockAt(checkPos);
                    const blockBelowPos = this.bot.blockAt(checkPos.offset(0, -1, 0));

                    if (blockAtPos && blockAtPos.name === 'air' && blockBelowPos && blockBelowPos.boundingBox === 'block') {
                        this.log(`Found suitable position at ${checkPos}`);
                        return checkPos;
                    }
                }
            }
        }
        return null; // No suitable position found
    }
}

module.exports = Bot;
