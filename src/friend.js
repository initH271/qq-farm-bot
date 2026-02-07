/**
 * 好友农场操作 - 进入/离开/帮忙/偷菜/巡查
 */

const { CONFIG, PlantPhase, PHASE_NAMES } = require('./config');
const { types } = require('./proto');
const { sendMsgAsync, getUserState } = require('./network');
const { toLong, toNum, getServerTimeSec, log, logWarn, sleep } = require('./utils');
const { getCurrentPhase } = require('./farm');

// ============ 内部状态 ============
let isCheckingFriends = false;
let isFirstFriendCheck = true;
let friendCheckTimer = null;

// ============ 好友 API ============

async function getAllFriends() {
    const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
    return types.GetAllFriendsReply.decode(replyBody);
}

async function enterFriendFarm(friendGid) {
    const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2,  // ENTER_REASON_FRIEND
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
    return types.VisitEnterReply.decode(replyBody);
}

async function leaveFriendFarm(friendGid) {
    const body = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({
        host_gid: toLong(friendGid),
    })).finish();
    try {
        await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body);
    } catch (e) { /* 离开失败不影响主流程 */ }
}

async function helpWater(friendGid, landIds) {
    const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    return types.WaterLandReply.decode(replyBody);
}

async function helpWeed(friendGid, landIds) {
    const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
    return types.WeedOutReply.decode(replyBody);
}

async function helpInsecticide(friendGid, landIds) {
    const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
    return types.InsecticideReply.decode(replyBody);
}

async function stealHarvest(friendGid, landIds) {
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}

// ============ 好友土地分析 ============

function analyzeFriendLands(lands) {
    const result = { stealable: [], needWater: [], needWeed: [], needBug: [] };

    for (const land of lands) {
        const id = toNum(land.id);
        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;

        const currentPhase = getCurrentPhase(plant.phases, false, '');
        if (!currentPhase) continue;
        const phaseVal = currentPhase.phase;

        if (phaseVal === PlantPhase.MATURE) {
            if (plant.stealable) result.stealable.push(id);
            continue;
        }

        if (phaseVal === PlantPhase.DEAD) continue;

        if (toNum(plant.dry_num) > 0) result.needWater.push(id);
        if (plant.weed_owners && plant.weed_owners.length > 0) result.needWeed.push(id);
        if (plant.insect_owners && plant.insect_owners.length > 0) result.needBug.push(id);
    }
    return result;
}

// ============ 拜访好友 ============

async function visitFriend(friend, totalActions) {
    const { gid, name, reason } = friend;
    log('拜访', `${name} (${reason})`);

    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e) {
        logWarn('拜访', `进入 ${name} 农场失败: ${e.message}`);
        return;
    }

    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        if (isFirstFriendCheck) console.log(`    ${name}: 返回土地数为0`);
        await leaveFriendFarm(gid);
        return;
    }

    // 首次巡查打印详细日志
    if (isFirstFriendCheck) {
        const friendName = enterReply.basic ? (enterReply.basic.name || '') : '';
        console.log(`    ${name}(${friendName}): 共 ${lands.length} 块土地`);
        for (const land of lands.slice(0, 5)) {
            const id = toNum(land.id);
            const p = land.plant;
            if (!p || !p.phases || p.phases.length === 0) {
                console.log(`      土地#${id}: 无植物`);
                continue;
            }
            const phase = getCurrentPhase(p.phases, false, '');
            const phaseName = phase ? (PHASE_NAMES[phase.phase] || `阶段${phase.phase}`) : '未知';
            console.log(`      土地#${id}: ${p.name||'?'} 阶段=${phaseName} dry=${toNum(p.dry_num)} weed=${(p.weed_owners||[]).length} insect=${(p.insect_owners||[]).length} stealable=${p.stealable} left_fruit=${toNum(p.left_fruit_num)}`);
        }
        if (lands.length > 5) console.log(`      ... 还有 ${lands.length - 5} 块`);
    }

    const status = analyzeFriendLands(lands);
    const parts = [];
    if (status.stealable.length) parts.push(`可偷:${status.stealable.length}`);
    if (status.needWater.length) parts.push(`缺水:${status.needWater.length}`);
    if (status.needWeed.length) parts.push(`有草:${status.needWeed.length}`);
    if (status.needBug.length) parts.push(`有虫:${status.needBug.length}`);

    if (parts.length === 0) {
        log('拜访', `${name} 无需操作`);
        await leaveFriendFarm(gid);
        return;
    }
    log('拜访', `${name} 详细: ${parts.join(' | ')}`);

    // 帮忙除草
    if (status.needWeed.length > 0) {
        let ok = 0, fail = 0;
        for (const landId of status.needWeed) {
            try { await helpWeed(gid, [landId]); ok++; } catch (e) { fail++; if (isFirstFriendCheck) console.log(`      除草#${landId}失败: ${e.message}`); }
            await sleep(300);
        }
        if (ok > 0) { log('帮忙', `帮 ${name} 除草 ${ok} 块${fail > 0 ? ` (${fail}块失败)` : ''}`); totalActions.weed += ok; }
    }

    // 帮忙除虫
    if (status.needBug.length > 0) {
        let ok = 0, fail = 0;
        for (const landId of status.needBug) {
            try { await helpInsecticide(gid, [landId]); ok++; } catch (e) { fail++; if (isFirstFriendCheck) console.log(`      除虫#${landId}失败: ${e.message}`); }
            await sleep(300);
        }
        if (ok > 0) { log('帮忙', `帮 ${name} 除虫 ${ok} 块${fail > 0 ? ` (${fail}块失败)` : ''}`); totalActions.bug += ok; }
    }

    // 帮忙浇水
    if (status.needWater.length > 0) {
        let ok = 0, fail = 0;
        for (const landId of status.needWater) {
            try { await helpWater(gid, [landId]); ok++; } catch (e) { fail++; if (isFirstFriendCheck) console.log(`      浇水#${landId}失败: ${e.message}`); }
            await sleep(300);
        }
        if (ok > 0) { log('帮忙', `帮 ${name} 浇水 ${ok} 块${fail > 0 ? ` (${fail}块失败)` : ''}`); totalActions.water += ok; }
    }

    // 偷菜
    if (status.stealable.length > 0) {
        let stoleCount = 0, failCount = 0;
        for (const landId of status.stealable) {
            try {
                await stealHarvest(gid, [landId]);
                stoleCount++;
            } catch (e) {
                failCount++;
                if (isFirstFriendCheck) console.log(`      偷菜#${landId}失败: ${e.message}`);
            }
            await sleep(300);
        }
        if (stoleCount > 0) {
            log('偷菜', `从 ${name} 偷了 ${stoleCount} 块地${failCount > 0 ? ` (${failCount}块失败)` : ''}`);
            totalActions.steal += stoleCount;
        } else if (failCount > 0) {
            log('偷菜', `${name} 全部 ${failCount} 块偷取失败`);
        }
    }

    await leaveFriendFarm(gid);
}

// ============ 好友巡查主循环 ============

async function checkFriends() {
    const state = getUserState();
    if (isCheckingFriends || !state.gid) return;
    isCheckingFriends = true;

    try {
        const friendsReply = await getAllFriends();
        const friends = friendsReply.game_friends || [];
        if (friends.length === 0) { log('好友', '没有好友'); return; }
        log('好友', `共 ${friends.length} 位好友，开始巡查...`);

        const friendsToVisit = [];
        const visitedGids = new Set();
        for (const f of friends) {
            const gid = toNum(f.gid);
            if (gid === state.gid) continue;
            if (visitedGids.has(gid)) continue;
            const name = f.remark || f.name || `GID:${gid}`;
            const p = f.plant;
            if (!p) continue;

            const stealNum = toNum(p.steal_plant_num);
            const dryNum = toNum(p.dry_num);
            const weedNum = toNum(p.weed_num);
            const insectNum = toNum(p.insect_num);
            if (stealNum > 0 || dryNum > 0 || weedNum > 0 || insectNum > 0) {
                const parts = [];
                if (stealNum > 0) parts.push(`可偷:${stealNum}`);
                if (dryNum > 0) parts.push(`缺水:${dryNum}`);
                if (weedNum > 0) parts.push(`有草:${weedNum}`);
                if (insectNum > 0) parts.push(`有虫:${insectNum}`);
                friendsToVisit.push({ gid, name, reason: parts.join(' ') });
                visitedGids.add(gid);
            }
        }

        if (friendsToVisit.length === 0) { log('好友', '所有好友农场无需操作'); return; }
        log('好友', `${friendsToVisit.length} 位好友需要拜访`);

        let totalActions = { steal: 0, water: 0, weed: 0, bug: 0 };
        for (const friend of friendsToVisit) {
            try { await visitFriend(friend, totalActions); } catch (e) { logWarn('好友', `拜访 ${friend.name} 失败: ${e.message}`); }
            await sleep(800);
        }

        const summary = [];
        if (totalActions.steal > 0) summary.push(`偷菜:${totalActions.steal}块`);
        if (totalActions.water > 0) summary.push(`浇水:${totalActions.water}块`);
        if (totalActions.weed > 0) summary.push(`除草:${totalActions.weed}块`);
        if (totalActions.bug > 0) summary.push(`除虫:${totalActions.bug}块`);
        log('好友', `巡查完毕! ${summary.length > 0 ? summary.join(' | ') : '无操作'}`);
        isFirstFriendCheck = false;
    } catch (err) {
        logWarn('好友', `巡查失败: ${err.message}`);
    } finally {
        isCheckingFriends = false;
    }
}

function startFriendCheckLoop() {
    log('挂机', `好友自动巡查已启动 (每 ${CONFIG.friendCheckInterval / 1000} 秒)`);
    setTimeout(() => checkFriends(), 8000);
    if (friendCheckTimer) clearInterval(friendCheckTimer);
    friendCheckTimer = setInterval(() => checkFriends(), CONFIG.friendCheckInterval);
}

function stopFriendCheckLoop() {
    if (friendCheckTimer) { clearInterval(friendCheckTimer); friendCheckTimer = null; }
}

module.exports = {
    checkFriends, startFriendCheckLoop, stopFriendCheckLoop,
};
