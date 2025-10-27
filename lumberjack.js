require('dotenv').config();
const Bot = require('./Bot');
const { GoalNear } = require('mineflayer-pathfinder').goals;

class Lumberjack extends Bot {
    constructor() {
        super('Lumberjack', 'Lumberjack');
        this.busy = false;
    }

    onSpawn() {
        this.log("Ready to chop wood. Starting main loop.");
        this.startMainLoop();
    }

    startMainLoop() {
        if (this.mainLoopInterval) return;
        this.mainLoopInterval = setInterval(() => {
            if (!this.busy) {
                this.workCycle();
            }
        }, 5000); // Start a cycle every 5 seconds if not busy
    }

    async workCycle() {
        this.busy = true;
        try {
            this.log("Starting new work cycle.");
            const woodGathered = await this.getWood(5);
            if (woodGathered > 0) {
                const dropLocation = await this.findDropLocation();
                await this.dropItemsAt(dropLocation);
                this.sendMessage({ event: 'wood_dropped', location: dropLocation, quantity: woodGathered });
            } else {
                this.log("Didn't gather any wood, skipping drop.");
            }
        } catch (error) {
            this.log(`Work cycle failed: ${error}`);
        }
        this.busy = false;
    }

    async getWood(count) {
        const initialWoodCount = this.bot.inventory.items().find(item => this.LOG_NAMES.includes(item.name))?.count || 0;

        const logIds = this.LOG_NAMES.map(name => this.mcData.blocksByName[name].id);
        const targetBlock = this.bot.findBlock({ matching: logIds, maxDistance: 64 });
        if (!targetBlock) throw new Error("No wood found nearby.");

        await this.bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));

        for (let i = 0; i < count; i++) {
            const nextLog = this.bot.findBlock({ matching: logIds, maxDistance: 3 });
            if (nextLog) await this.bot.dig(nextLog);
            else break;
        }
        const finalWoodCount = this.bot.inventory.items().find(item => this.LOG_NAMES.includes(item.name))?.count || 0;
        return finalWoodCount - initialWoodCount;
    }

    async findDropLocation() {
        const referenceBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
        const dropPosition = await this.bot.findPlaceablePosition(referenceBlock.position, 4);
        if (!dropPosition) throw new Error("Could not find a clear spot to drop items.");
        return dropPosition.offset(0,1,0); // The space above the solid block
    }

    async dropItemsAt(location) {
        await this.bot.pathfinder.goto(new GoalNear(location.x, location.y, location.z, 2));

        const itemsToDrop = this.bot.inventory.items().filter(item => this.LOG_NAMES.includes(item.name));
        if (itemsToDrop.length === 0) return;

        for (const item of itemsToDrop) {
            await this.bot.tossStack(item);
        }
        this.log(`Dropped logs at ${location.x}, ${location.y}, ${location.z}`);
    }
}

const lumberjack = new Lumberjack();
lumberjack.start();
