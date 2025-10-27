require('dotenv').config();
const Bot = require('./Bot');
const { GoalNear } = require('mineflayer-pathfinder').goals;

class Lumberjack extends Bot {
    constructor() {
        super('Lumberjack');
        this.sharedChestLocation = null;
        this.taskQueue = ['gather_wood', 'deposit_wood'];
        this.busy = false;
    }

    onSpawn() {
        this.log("Spawned. Waiting for shared chest location...");
    }

    handleMessage(data) {
        if (data.event === 'shared_chest_created') {
            this.log(`Received shared chest location: ${JSON.stringify(data.location)}`);
            this.sharedChestLocation = data.location;
            // Once the chest location is known, start the main work loop.
            this.startMainLoop();
        }
    }

    startMainLoop() {
        if (this.mainLoopInterval) return; // Ensure loop is only started once
        this.log("Chest location known. Starting main work loop.");
        this.mainLoopInterval = setInterval(() => {
            if (!this.busy) {
                this.runNextTask();
            }
        }, 1000);
    }

    async runNextTask() {
        if (this.taskQueue.length === 0) {
            this.taskQueue.push('gather_wood', 'deposit_wood'); // Loop tasks
        }

        const task = this.taskQueue.shift();
        this.log(`Starting task: ${task}`);
        this.busy = true;

        try {
            switch (task) {
                case 'gather_wood':
                    await this.getWood(5);
                    break;
                case 'deposit_wood':
                    await this.depositItemsInChest();
                    this.sendMessage({ event: 'wood_deposited' });
                    break;
            }
            this.log(`Task ${task} completed.`);
        } catch (error) {
            this.log(`Task ${task} failed: ${error}`);
            this.taskQueue.unshift(task);
            await this.bot.waitForTicks(100);
        }
        this.busy = false;
    }

    async getWood(count) {
        const logIds = this.LOG_NAMES.map(name => this.mcData.blocksByName[name].id);
        const targetBlock = this.bot.findBlock({ matching: logIds, maxDistance: 64 });
        if (!targetBlock) throw new Error("No wood found nearby.");

        await this.bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));

        for (let i = 0; i < count; i++) {
            const nextLog = this.bot.findBlock({ matching: logIds, maxDistance: 3 });
            if (nextLog) await this.bot.dig(nextLog);
        }
    }

    async depositItemsInChest() {
        if (!this.sharedChestLocation) throw new Error("Chest location is unknown.");

        await this.bot.pathfinder.goto(new GoalNear(this.sharedChestLocation.x, this.sharedChestLocation.y, this.sharedChestLocation.z, 2));

        const chestBlock = this.bot.blockAt(this.sharedChestLocation);
        if (!chestBlock || !chestBlock.name.includes('chest')) {
            throw new Error("Chest not found at the received location.");
        }

        const chest = await this.bot.openChest(chestBlock);
        this.log("Opened chest. Depositing logs.");

        for (const item of this.bot.inventory.items()) {
            if (this.LOG_NAMES.includes(item.name)) {
                await chest.deposit(item.type, null, item.count);
            }
        }
        await chest.close();
    }
}

const lumberjack = new Lumberjack();
lumberjack.start();
