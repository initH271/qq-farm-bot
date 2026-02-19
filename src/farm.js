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
    const { network, timeSync, logger, notify } = deps;
    const { sendMsgAsync, getUserState } = network;
    const { getServerTimeSec } = timeSync;
    const { log, logWarn } = logger;

    // ============ 每用户私有状态 ============
    let isCheckingFarm = false;
    let isFirstFarmCheck = true;
    let farmCheckTimer = null;
    let organicFertDepleted = false;

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
        let successCount = 0;
        for (const landId of landIds) {
            try {
                const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                    land_ids: [toLong(landId)],
                    fertilizer_id: toLong(fertilizerId),
                })).finish();
                await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
                successCount++;
            } catch (e) {
                log('施肥', `土地#${landId} 施肥失败: ${e.message}，停止施肥`);
                break;
            }
            if (landIds.length > 1) await sleep(50);
        }
        return successCount;
    }

    async function fertilizeOrganic(landIds, fertilizerId) {
        let successCount = 0;
        for (const landId of landIds) {
            try {
                const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                    land_ids: [toLong(landId)],
                    fertilizer_id: toLong(fertilizerId),
                })).finish();
                await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
                successCount++;
            } catch (e) {
                // 物品不足等全局性错误，停止所有施肥
                if (e.message && /不足|没有|不够/.test(e.message)) {
                    log('施肥', `有机肥不足，停止施肥: ${e.message}`);
                    organicFertDepleted = true;
                    if (notify) notify(`⚠️ 有机肥已耗尽`);
                    break;
                }
                // 单块地失败（已成熟等），跳过继续
            }
            if (landIds.length > 1) await sleep(50);
        }
        return successCount;
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

        if (CONFIG.forceLowestLevelCrop) {
            available.sort((a, b) => a.requiredLevel - b.requiredLevel || a.price - b.price);
        } else {
            available.sort((a, b) => b.requiredLevel - a.requiredLevel || b.price - a.price);
        }
        return available[0];
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

        const seed = seeds;
        log('商店', `种子: goods_id=${seed.goodsId} item_id=${seed.seedId} 价格=${seed.price}金币 (等级:${seed.requiredLevel})`);

        // 购买+种植辅助函数，返回实际种植的土地数
        async function buyAndPlant(s, lands, label) {
            if (lands.length === 0) return 0;

            const totalCost = s.price * lands.length;
            if (totalCost > state.gold) {
                const canBuy = Math.floor(state.gold / s.price);
                if (canBuy <= 0) {
                    logWarn('商店', `${label}: 金币不足，跳过`);
                    return 0;
                }
                lands = lands.slice(0, canBuy);
                log('商店', `${label}: 金币有限，只种 ${canBuy} 块地`);
            }

            let actualSeedId = s.seedId;
            try {
                const buyReply = await buyGoods(s.goodsId, lands.length, s.price);
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
                log('购买', `${label}: 已购买种子x${lands.length}, 花费 ${s.price * lands.length} 金币, seed_id=${actualSeedId}`);
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
        const planted = await buyAndPlant(seed, landsToPlant, '种植');
        if (planted > 0) {
            const fertilized = await fertilize(landsToPlant, NORMAL_FERTILIZER_ID);
            if (fertilized > 0) log('施肥', `已对 ${fertilized} 块地施普通肥`);
            if (notify) notify(`🌱 种植 ${seed.goodsId} x${planted} 块\n花费 ${seed.price * planted} 金币`);
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
                result.harvestable.push({ id, name: plantName });
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
                const leftFertTimes = toNum(plant.left_inorc_fert_times);
                log('巡田', `    → 结果: 生长中(${PHASE_NAMES[phaseVal] || phaseVal})${needStr} left_inorc_fert_times=${leftFertTimes}`);
            }
        }

        if (debug) {
            log('巡田', '========== 巡田分析汇总 ==========');
            log('巡田', `可收获: ${result.harvestable.length} [${result.harvestable.map(h => h.id).join(',')}]`);
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
            if (status.harvestable.length) statusParts.push(`可收获:${status.harvestable.length}(${status.harvestable.map(h => h.id).join(',')})`);
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
                const harvestIds = status.harvestable.map(h => h.id);
                try {
                    await harvest(harvestIds);
                    log('收获', `已收获 ${status.harvestable.length} 块地 (${harvestIds.join(',')})`);
                    harvestedLandIds = [...harvestIds];
                    // 统计作物名称
                    const cropCounts = {};
                    for (const h of status.harvestable) {
                        cropCounts[h.name] = (cropCounts[h.name] || 0) + 1;
                    }
                    const cropSummary = Object.entries(cropCounts).map(([name, cnt]) => `${name}x${cnt}`).join(' ');
                    if (notify) notify(`🌾 收获 ${status.harvestable.length} 块地\n${cropSummary}`);
                } catch (e) { logWarn('收获', e.message); }
                await sleep(500);
            }

            const allDeadLands = [...status.dead, ...harvestedLandIds];
            const allEmptyLands = [...status.empty];
            if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
                try { await autoPlantEmptyLands(allDeadLands, allEmptyLands); } catch (e) { logWarn('自动种植', e.message); }
                organicFertDepleted = false; // 新种植后重置有机肥耗尽标记
                await sleep(500);
            }

            if (status.growing.length > 0 && !organicFertDepleted) {
                const fertilized = await fertilizeOrganic(status.growing, CONFIG.organicFertilizerId);
                if (fertilized > 0) {
                    log('施肥', `已对 ${fertilized}/${status.growing.length} 块地施有机肥`);
                }
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
