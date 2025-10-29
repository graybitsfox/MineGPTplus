require('dotenv').config();
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoeatLoader } = require('mineflayer-auto-eat')
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = 'fs/promises';
const path = 'path';

// ... (Constants are unchanged)

class Bot {
    // ... (Constructor and gatherItem are unchanged)

    // --- NEW: Safe pathfinding with a timeout ---
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
    }

    // ... (The rest of the file remains unchanged)
}

module.exports = Bot;
