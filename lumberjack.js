require('dotenv').config();
const Bot = require('./Bot');
const { GoalNear } = require('mineflayer-pathfinder').goals;

const CHEST_POSITION = { x: 10, y: 64, z: 10 }; // Hardcoded chest position for simplicity

class Lumberjack extends Bot {
    constructor() {
        super('Lumberjack');
        this.taskQueue = ['gather_wood', 'deposit_wood'];
        this.busy = false;
    }

    onSpawn() {
        this.log("Ready to chop wood.");
        this.startMainLoop();
    }

    startMainLoop() {
        setInterval(() => {
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
            this.taskQueue.unshift(task); // Re-queue failed task
            await this.bot.waitForTicks(100); // Wait 5 seconds before retrying
        }
        this.busy = false;
    }

    async getWood(count) {
        const logIds = this.LOG_NAMES.map(name => this.mcData.blocksByName[name].id);
        const targetBlock = this.bot.findBlock({ matching: logIds, maxDistance: 64 });
        if (!targetBlock) throw new Error("No wood found nearby.");

        this.log(`Found wood. Going to it.`);
        await this.bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));

        this.log(`Mining ${count} logs.`);
        for (let i = 0; i < count; i++) {
            const nextLog = this.bot.findBlock({ matching: logIds, maxDistance: 3 });
            if (nextLog) {
                await this.bot.dig(nextLog);
                this.log(`Mined a log. (${i + 1}/${count})`);
            } else {
                break;
            }
        }
    }

    async depositItemsInChest() {
        await this.bot.pathfinder.goto(new GoalNear(CHEST_POSITION.x, CHEST_POSITION.y, CHEST_POSITION.z, 2));

        const chestBlock = this.bot.blockAt(this.bot.entity.position.offset(CHEST_POSITION.x, CHEST_POSITION.y, CHEST_POSITION.z));
        if (!chestBlock || !chestBlock.name.includes('chest')) {
            // For simplicity, we just place a chest if it's not there.
            // In a real scenario, the Lumberjack might need to craft one.
            const chestItem = this.bot.inventory.items().find(item => item.name.includes('chest'));
            if(chestItem) await this.bot.placeBlock(this.bot.blockAt(this.bot.entity.position.offset(1,0,0)), {x:0, y:1, z:0});
            else {
                this.log("No chest nearby, and I can't make one. Skipping deposit.");
                return;
            }
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
