/**
 * 游戏配置数据模块（全局共享，只读数据）
 * 从 gameConfig 目录加载配置数据
 */

const fs = require('fs');
const path = require('path');

// ============ 等级经验表 ============
let roleLevelConfig = null;
let levelExpTable = null;

// ============ 植物配置 ============
let plantConfig = null;
let plantMap = new Map();
let seedToPlant = new Map();
let fruitToPlant = new Map();

/**
 * 加载配置文件
 */
function loadConfigs() {
    const configDir = path.join(__dirname, '..', 'gameConfig');

    try {
        const roleLevelPath = path.join(configDir, 'RoleLevel.json');
        if (fs.existsSync(roleLevelPath)) {
            roleLevelConfig = JSON.parse(fs.readFileSync(roleLevelPath, 'utf8'));
            levelExpTable = [];
            for (const item of roleLevelConfig) {
                levelExpTable[item.level] = item.exp;
            }
            console.log(`[配置] 已加载等级经验表 (${roleLevelConfig.length} 级)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 RoleLevel.json 失败:', e.message);
    }

    try {
        const plantPath = path.join(configDir, 'Plant.json');
        if (fs.existsSync(plantPath)) {
            plantConfig = JSON.parse(fs.readFileSync(plantPath, 'utf8'));
            plantMap.clear();
            seedToPlant.clear();
            fruitToPlant.clear();
            for (const plant of plantConfig) {
                plantMap.set(plant.id, plant);
                if (plant.seed_id) {
                    seedToPlant.set(plant.seed_id, plant);
                }
                if (plant.fruit && plant.fruit.id) {
                    fruitToPlant.set(plant.fruit.id, plant);
                }
            }
            console.log(`[配置] 已加载植物配置 (${plantConfig.length} 种)`);
        }
    } catch (e) {
        console.warn('[配置] 加载 Plant.json 失败:', e.message);
    }
}

// ============ 等级经验相关 ============

function getLevelExpTable() {
    return levelExpTable;
}

function getLevelExpProgress(level, totalExp) {
    if (!levelExpTable || level <= 0) return { current: 0, needed: 0 };

    const currentLevelStart = levelExpTable[level] || 0;
    const nextLevelStart = levelExpTable[level + 1] || (currentLevelStart + 100000);

    const currentExp = Math.max(0, totalExp - currentLevelStart);
    const neededExp = nextLevelStart - currentLevelStart;

    return { current: currentExp, needed: neededExp };
}

// ============ 植物配置相关 ============

function getPlantById(plantId) {
    return plantMap.get(plantId);
}

function getPlantBySeedId(seedId) {
    return seedToPlant.get(seedId);
}

function getPlantName(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? plant.name : `植物${plantId}`;
}

function getPlantNameBySeedId(seedId) {
    const plant = seedToPlant.get(seedId);
    return plant ? plant.name : `种子${seedId}`;
}

function getPlantFruit(plantId) {
    const plant = plantMap.get(plantId);
    if (!plant || !plant.fruit) return null;
    return {
        id: plant.fruit.id,
        count: plant.fruit.count,
        name: plant.name,
    };
}

function getPlantGrowTime(plantId) {
    const plant = plantMap.get(plantId);
    if (!plant || !plant.grow_phases) return 0;

    const phases = plant.grow_phases.split(';').filter(p => p);
    let totalSeconds = 0;
    for (const phase of phases) {
        const match = phase.match(/:(\d+)/);
        if (match) {
            totalSeconds += parseInt(match[1]);
        }
    }
    return totalSeconds;
}

function getPlantExp(plantId) {
    const plant = plantMap.get(plantId);
    return plant ? plant.exp : 0;
}

function getFruitName(fruitId) {
    const plant = fruitToPlant.get(fruitId);
    return plant ? plant.name : `果实${fruitId}`;
}

function getPlantByFruitId(fruitId) {
    return fruitToPlant.get(fruitId);
}

// 启动时加载配置
loadConfigs();

module.exports = {
    loadConfigs,
    getLevelExpTable,
    getLevelExpProgress,
    getPlantById,
    getPlantBySeedId,
    getPlantName,
    getPlantNameBySeedId,
    getPlantFruit,
    getPlantGrowTime,
    getPlantExp,
    getFruitName,
    getPlantByFruitId,
};
