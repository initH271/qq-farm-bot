/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const protobuf = require('protobufjs');
const { CONFIG, PlantPhase, PHASE_NAMES } = require('./config');
const { types } = require('./proto');
const { toLong, toNum, toTimeSec, sleep } = require('./utils');

/**
 * 创建一个独立的农场管理实例
 * @param {Object} deps
 * @param {Object} deps.network  - { sendMsgAsync, getUserState }
 * @param {Object} deps.timeSync - { getServerTimeSec }
 * @param {Object} deps.logger   - { log, logWarn }
 */
function createFarm(deps) {
    const { network, timeSync, logger } = deps;
    const { sendMsgAsync, getUserState } = network;
    const { getServerTimeSec } = timeSync;
    const { log, logWarn } = logger;

    // ============ 每用户私有状态 ============
    let isCheckingFarm = false;
    let isFirstFarmCheck = true;
    let farmCheckTimer = null;

    // ============ 农场 API ============

    async function getAllLands() {
        const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
        return types.AllLandsReply.decode(replyBody);
    }

    async function harvest(landIds) {
        const state = getUserState();
        const body = types.HarvestRequest.encode(types.HarvestRequest.create({
            land_ids: landIds,
            host_gid: toLong(state.gid),
            is_all: true,
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
        return types.HarvestReply.decode(replyBody);
    }

    async function waterLand(landIds) {
        const state = getUserState();
        const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
            land_ids: landIds,
            host_gid: toLong(state.gid),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
        return types.WaterLandReply.decode(replyBody);
    }

    async function weedOut(landIds) {
        const state = getUserState();
        const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
            land_ids: landIds,
            host_gid: toLong(state.gid),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
        return types.WeedOutReply.decode(replyBody);
    }

    async function insecticide(landIds) {
        const state = getUserState();
        const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
            land_ids: landIds,
            host_gid: toLong(state.gid),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
        return types.InsecticideReply.decode(replyBody);
    }

    async function removePlant(landIds) {
        const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
            land_ids: landIds.map(id => toLong(id)),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
        return types.RemovePlantReply.decode(replyBody);
    }

    async function fertilize(landIds, fertilizerId) {
        const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
            land_ids: landIds,
            fertilizer_id: toLong(fertilizerId),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
        return types.FertilizeReply.decode(replyBody);
    }

    // ============ 商店 API ============

    async function getShopInfo(shopId) {
        const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
            shop_id: toLong(shopId),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
        return types.ShopInfoReply.decode(replyBody);
    }

    async function buyGoods(goodsId, num, price) {
        const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
            goods_id: toLong(goodsId),
            num: toLong(num),
            price: toLong(price),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
        return types.BuyGoodsReply.decode(replyBody);
    }

    // ============ 种植 ============

    function encodePlantRequest(seedId, landIds) {
        const writer = protobuf.Writer.create();
        const itemWriter = writer.uint32(18).fork();
        itemWriter.uint32(8).int64(seedId);
        const idsWriter = itemWriter.uint32(18).fork();
        for (const id of landIds) {
            idsWriter.int64(id);
        }
        idsWriter.ldelim();
        itemWriter.ldelim();
        return writer.finish();
    }

    async function plantSeeds(seedId, landIds) {
        let successCount = 0;
        for (const landId of landIds) {
            try {
                const body = encodePlantRequest(seedId, [landId]);
                if (successCount === 0) {
                    log('种植', `seed_id=${seedId} land_id=${landId} hex=${Buffer.from(body).toString('hex')}`);
                }
                const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
                types.PlantReply.decode(replyBody);
                successCount++;
            } catch (e) {
                logWarn('种植', `土地#${landId} 失败: ${e.message}`);
            }
            await sleep(300);
        }
        return successCount;
    }

    async function findSeeds() {
        const SEED_SHOP_ID = 2;
        const shopReply = await getShopInfo(SEED_SHOP_ID);
        if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
            logWarn('商店', '种子商店无商品');
            return null;
        }

        const state = getUserState();
        const available = [];
        for (const goods of shopReply.goods_list) {
            if (!goods.unlocked) continue;

            let meetsConditions = true;
            let requiredLevel = 0;
            const conds = goods.conds || [];
            for (const cond of conds) {
                if (toNum(cond.type) === 1) {
                    requiredLevel = toNum(cond.param);
                    if (state.level < requiredLevel) {
                        meetsConditions = false;
                        break;
                    }
                }
            }
            if (!meetsConditions) continue;

            const limitCount = toNum(goods.limit_count);
            const boughtNum = toNum(goods.bought_num);
            if (limitCount > 0 && boughtNum >= limitCount) continue;

            available.push({
                goods,
                goodsId: toNum(goods.id),
                seedId: toNum(goods.item_id),
                price: toNum(goods.price),
                requiredLevel,
            });
        }

        if (available.length === 0) {
            logWarn('商店', '没有可购买的种子');
            return null;
        }

        const byLevel = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel);
        const byPrice = [...available].sort((a, b) => a.price - b.price);

        return { best: byLevel[0], cheapest: byPrice[0] };
    }

    async function autoPlantEmptyLands(deadLandIds, emptyLandIds) {
        let landsToPlant = [...emptyLandIds];
        const state = getUserState();

        if (deadLandIds.length > 0) {
            try {
                await removePlant(deadLandIds);
                log('铲除', `已铲除 ${deadLandIds.length} 块作物残留 (${deadLandIds.join(',')})`);
                landsToPlant.push(...deadLandIds);
            } catch (e) {
                logWarn('铲除', `批量铲除失败: ${e.message}, 尝试逐块铲除...`);
                for (const landId of deadLandIds) {
                    try {
                        await removePlant([landId]);
                        landsToPlant.push(landId);
                    } catch (e2) {
                        landsToPlant.push(landId);
                    }
                    await sleep(300);
                }
            }
            await sleep(500);
        }

        if (landsToPlant.length === 0) return;

        let seeds;
        try {
            seeds = await findSeeds();
        } catch (e) {
            logWarn('商店', `查询失败: ${e.message}`);
            return;
        }
        if (!seeds) return;

        const { best, cheapest } = seeds;
        const sameSeed = best.seedId === cheapest.seedId;

        if (sameSeed) {
            log('商店', `最佳种子与最便宜种子相同: goods_id=${best.goodsId} item_id=${best.seedId} 价格=${best.price}金币 (等级要求:${best.requiredLevel})`);
        } else {
            log('商店', `高级种子: goods_id=${best.goodsId} item_id=${best.seedId} 价格=${best.price}金币 (等级要求:${best.requiredLevel})`);
            log('商店', `低价种子: goods_id=${cheapest.goodsId} item_id=${cheapest.seedId} 价格=${cheapest.price}金币 (等级要求:${cheapest.requiredLevel})`);
        }

        // 购买+种植辅助函数，返回实际种植的土地数
        async function buyAndPlant(seed, lands, label) {
            if (lands.length === 0) return 0;

            const totalCost = seed.price * lands.length;
            if (totalCost > state.gold) {
                const canBuy = Math.floor(state.gold / seed.price);
                if (canBuy <= 0) {
                    logWarn('商店', `${label}: 金币不足，跳过`);
                    return 0;
                }
                lands = lands.slice(0, canBuy);
                log('商店', `${label}: 金币有限，只种 ${canBuy} 块地`);
            }

            let actualSeedId = seed.seedId;
            try {
                const buyReply = await buyGoods(seed.goodsId, lands.length, seed.price);
                if (buyReply.get_items && buyReply.get_items.length > 0) {
                    const gotItem = buyReply.get_items[0];
                    const gotId = toNum(gotItem.id);
                    const gotCount = toNum(gotItem.count);
                    log('购买', `${label}: 获得物品 id=${gotId} count=${gotCount}`);
                    if (gotId > 0) actualSeedId = gotId;
                }
                if (buyReply.cost_items) {
                    for (const item of buyReply.cost_items) {
                        state.gold -= toNum(item.count);
                    }
                }
                log('购买', `${label}: 已购买种子x${lands.length}, 花费 ${seed.price * lands.length} 金币, seed_id=${actualSeedId}`);
            } catch (e) {
                logWarn('购买', `${label}: ${e.message}`);
                return 0;
            }
            await sleep(500);

            try {
                const planted = await plantSeeds(actualSeedId, lands);
                log('种植', `${label}: 已在 ${planted} 块地种植 (${lands.join(',')})`);
                return planted;
            } catch (e) {
                logWarn('种植', `${label}: ${e.message}`);
                return 0;
            }
        }

        const NORMAL_FERTILIZER_ID = 1011;

        if (sameSeed) {
            // 同一种子：全部购买种植，全部施肥
            const planted = await buyAndPlant(best, landsToPlant, '种植');
            if (planted > 0) {
                let fertilized = 0;
                for (const landId of landsToPlant) {
                    try {
                        await fertilize([landId], NORMAL_FERTILIZER_ID);
                        fertilized++;
                    } catch (e) {
                        log('施肥', `土地#${landId} 施肥失败: ${e.message}，停止施肥`);
                        break;
                    }
                    await sleep(50);
                }
                if (fertilized > 0) {
                    log('施肥', `已对 ${fertilized} 块地施肥`);
                }
            }
        } else {
            // 不同种子：2/3高级+施肥，1/3低价+不施肥
            const cheapCount = Math.floor(landsToPlant.length / 3) || (landsToPlant.length >= 2 ? 1 : 0);
            const bestLands = landsToPlant.slice(0, landsToPlant.length - cheapCount);
            const cheapLands = landsToPlant.slice(landsToPlant.length - cheapCount);

            // 高级种子组
            const bestPlanted = await buyAndPlant(best, bestLands, '高级种子');
            if (bestPlanted > 0) {
                let fertilized = 0;
                for (const landId of bestLands) {
                    try {
                        await fertilize([landId], NORMAL_FERTILIZER_ID);
                        fertilized++;
                    } catch (e) {
                        log('施肥', `土地#${landId} 施肥失败: ${e.message}，停止施肥`);
                        break;
                    }
                    await sleep(50);
                }
                if (fertilized > 0) {
                    log('施肥', `已对 ${fertilized} 块地施肥(高级种子)`);
                }
            }
            await sleep(300);

            // 低价种子组（不施肥）
            if (cheapLands.length > 0) {
                await buyAndPlant(cheapest, cheapLands, '低价种子');
            }
        }
    }

    // ============ 土地分析 ============

    function getCurrentPhase(phases, debug, landLabel) {
        if (!phases || phases.length === 0) return null;

        const nowSec = getServerTimeSec();

        if (debug) {
            log('调试', `${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`);
            for (let i = 0; i < phases.length; i++) {
                const p = phases[i];
                const bt = toTimeSec(p.begin_time);
                const phaseName = PHASE_NAMES[p.phase] || `阶段${p.phase}`;
                const diff = bt > 0 ? (bt - nowSec) : 0;
                const diffStr = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
                log('调试', `${landLabel}   [${i}] ${phaseName}(${p.phase}) begin=${bt} ${diffStr} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`);
            }
        }

        for (let i = phases.length - 1; i >= 0; i--) {
            const beginTime = toTimeSec(phases[i].begin_time);
            if (beginTime > 0 && beginTime <= nowSec) {
                if (debug) {
                    log('调试', `${landLabel}   → 当前阶段: ${PHASE_NAMES[phases[i].phase] || phases[i].phase}`);
                }
                return phases[i];
            }
        }

        if (debug) {
            log('调试', `${landLabel}   → 所有阶段都在未来，使用第一个: ${PHASE_NAMES[phases[0].phase] || phases[0].phase}`);
        }
        return phases[0];
    }

    function analyzeLands(lands) {
        const result = {
            harvestable: [], needWater: [], needWeed: [], needBug: [],
            growing: [], empty: [], dead: [],
        };

        const nowSec = getServerTimeSec();
        const debug = isFirstFarmCheck;

        if (debug) {
            log('巡田', '========== 首次巡田详细日志 ==========');
            log('巡田', `服务器时间(秒): ${nowSec}  (${new Date(nowSec * 1000).toLocaleString()})`);
            log('巡田', `总土地数: ${lands.length}`);
        }

        for (const land of lands) {
            const id = toNum(land.id);
            if (!land.unlocked) {
                if (debug) log('巡田', `  土地#${id}: 未解锁`);
                continue;
            }

            const plant = land.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                result.empty.push(id);
                if (debug) log('巡田', `  土地#${id}: 空地`);
                continue;
            }

            const plantName = plant.name || '未知作物';
            const landLabel = `土地#${id}(${plantName})`;

            if (debug) {
                log('巡田', `  ${landLabel}: phases=${plant.phases.length} dry_num=${toNum(plant.dry_num)} weed_owners=${(plant.weed_owners||[]).length} insect_owners=${(plant.insect_owners||[]).length}`);
            }

            const currentPhase = getCurrentPhase(plant.phases, debug, landLabel);
            if (!currentPhase) {
                result.empty.push(id);
                continue;
            }
            const phaseVal = currentPhase.phase;

            if (phaseVal === PlantPhase.DEAD) {
                result.dead.push(id);
                if (debug) log('巡田', `    → 结果: 枯死`);
                continue;
            }

            if (phaseVal === PlantPhase.MATURE) {
                result.harvestable.push(id);
                if (debug) log('巡田', `    → 结果: 可收获`);
                continue;
            }

            let landNeeds = [];
            const dryNum = toNum(plant.dry_num);
            const dryTime = toTimeSec(currentPhase.dry_time);
            if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) {
                result.needWater.push(id);
                landNeeds.push('缺水');
            }

            const weedsTime = toTimeSec(currentPhase.weeds_time);
            const hasWeeds = (plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= nowSec);
            if (hasWeeds) {
                result.needWeed.push(id);
                landNeeds.push('有草');
            }

            const insectTime = toTimeSec(currentPhase.insect_time);
            const hasBugs = (plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= nowSec);
            if (hasBugs) {
                result.needBug.push(id);
                landNeeds.push('有虫');
            }

            result.growing.push(id);
            if (debug) {
                const needStr = landNeeds.length > 0 ? ` 需要: ${landNeeds.join(',')}` : '';
                log('巡田', `    → 结果: 生长中(${PHASE_NAMES[phaseVal] || phaseVal})${needStr}`);
            }
        }

        if (debug) {
            log('巡田', '========== 巡田分析汇总 ==========');
            log('巡田', `可收获: ${result.harvestable.length} [${result.harvestable.join(',')}]`);
            log('巡田', `生长中: ${result.growing.length} [${result.growing.join(',')}]`);
            log('巡田', `缺水:   ${result.needWater.length} [${result.needWater.join(',')}]`);
            log('巡田', `有草:   ${result.needWeed.length} [${result.needWeed.join(',')}]`);
            log('巡田', `有虫:   ${result.needBug.length} [${result.needBug.join(',')}]`);
            log('巡田', `空地:   ${result.empty.length} [${result.empty.join(',')}]`);
            log('巡田', `枯死:   ${result.dead.length} [${result.dead.join(',')}]`);
            log('巡田', '====================================');
        }

        return result;
    }

    // ============ 巡田主循环 ============

    async function checkFarm() {
        const state = getUserState();
        if (isCheckingFarm || !state.gid) return;
        isCheckingFarm = true;

        try {
            const landsReply = await getAllLands();
            if (!landsReply.lands || landsReply.lands.length === 0) {
                log('农场', '没有土地数据');
                return;
            }

            const lands = landsReply.lands;
            const status = analyzeLands(lands);
            isFirstFarmCheck = false;

            const statusParts = [];
            if (status.harvestable.length) statusParts.push(`可收获:${status.harvestable.length}(${status.harvestable.join(',')})`);
            if (status.needWater.length) statusParts.push(`缺水:${status.needWater.length}(${status.needWater.join(',')})`);
            if (status.needWeed.length) statusParts.push(`有草:${status.needWeed.length}(${status.needWeed.join(',')})`);
            if (status.needBug.length) statusParts.push(`有虫:${status.needBug.length}(${status.needBug.join(',')})`);
            if (status.growing.length) statusParts.push(`生长中:${status.growing.length}`);
            if (status.empty.length) statusParts.push(`空地:${status.empty.length}`);
            if (status.dead.length) statusParts.push(`枯死:${status.dead.length}`);

            log('巡田', statusParts.length > 0 ? statusParts.join(' | ') : '一切正常');
            log('巡田', `服务器时间: ${new Date(getServerTimeSec() * 1000).toLocaleString()}`);

            if (status.needWeed.length > 0) {
                try { await weedOut(status.needWeed); log('除草', `已除草 ${status.needWeed.length} 块地 (${status.needWeed.join(',')})`); } catch (e) { logWarn('除草', e.message); }
                await sleep(500);
            }

            if (status.needBug.length > 0) {
                try { await insecticide(status.needBug); log('除虫', `已除虫 ${status.needBug.length} 块地 (${status.needBug.join(',')})`); } catch (e) { logWarn('除虫', e.message); }
                await sleep(500);
            }

            if (status.needWater.length > 0) {
                try { await waterLand(status.needWater); log('浇水', `已浇水 ${status.needWater.length} 块地 (${status.needWater.join(',')})`); } catch (e) { logWarn('浇水', e.message); }
                await sleep(500);
            }

            let harvestedLandIds = [];
            if (status.harvestable.length > 0) {
                try {
                    await harvest(status.harvestable);
                    log('收获', `已收获 ${status.harvestable.length} 块地 (${status.harvestable.join(',')})`);
                    harvestedLandIds = [...status.harvestable];
                } catch (e) { logWarn('收获', e.message); }
                await sleep(500);
            }

            const allDeadLands = [...status.dead, ...harvestedLandIds];
            const allEmptyLands = [...status.empty];
            if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
                try { await autoPlantEmptyLands(allDeadLands, allEmptyLands); } catch (e) { logWarn('自动种植', e.message); }
                await sleep(500);
            }

            const actionCount = status.needWeed.length + status.needBug.length
                + status.needWater.length + status.harvestable.length
                + status.dead.length + allEmptyLands.length;
            if (actionCount === 0) {
                log('巡田', '无需操作，等待下次检查...');
            }
        } catch (err) {
            logWarn('巡田', `检查失败: ${err.message}`);
        } finally {
            isCheckingFarm = false;
        }
    }

    function startFarmCheckLoop() {
        log('挂机', `农场自动巡查已启动 (每 ${CONFIG.farmCheckInterval / 1000} 秒)`);
        setTimeout(() => checkFarm(), 2000);
        if (farmCheckTimer) clearInterval(farmCheckTimer);
        farmCheckTimer = setInterval(() => checkFarm(), CONFIG.farmCheckInterval);
    }

    function stopFarmCheckLoop() {
        if (farmCheckTimer) { clearInterval(farmCheckTimer); farmCheckTimer = null; }
    }

    return {
        checkFarm, startFarmCheckLoop, stopFarmCheckLoop,
        getCurrentPhase,
    };
}

module.exports = { createFarm };
