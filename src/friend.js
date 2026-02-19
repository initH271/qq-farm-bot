/**
 * 好友农场操作 - 进入/离开/帮忙/偷菜/放虫/放草/巡查/好友申请/操作限次/经验耗尽检测
 */

const { CONFIG, PlantPhase, PHASE_NAMES } = require('./config');
const { types } = require('./proto');
const { toLong, toNum, sleep } = require('./utils');

// 操作 ID 常量（与游戏服务器一致）
// 10001=收获, 10002=铲除, 10003=放草, 10004=放虫
// 10005=除草(帮好友), 10006=除虫(帮好友), 10007=浇水(帮好友), 10008=偷菜
const OP_PUT_WEED = 10003;
const OP_PUT_INSECT = 10004;
const OP_HELP_WEED = 10005;
const OP_HELP_INSECT = 10006;
const OP_HELP_WATER = 10007;
const OP_STEAL = 10008;

const OP_NAMES = {
    10003: '放草',
    10004: '放虫',
    10005: '除草',
    10006: '除虫',
    10007: '浇水',
    10008: '偷菜',
};

// 配置: 是否只在有经验时才帮助好友
const HELP_ONLY_WITH_EXP = true;

// 配置: 是否启用放虫放草功能
const ENABLE_PUT_BAD_THINGS = true;

/**
 * 创建一个独立的好友管理实例
 * @param {Object} deps
 * @param {Object} deps.network  - { sendMsgAsync, getUserState }
 * @param {Object} deps.timeSync - { getServerTimeSec }
 * @param {Object} deps.logger   - { log, logWarn }
 * @param {Object} deps.farm     - { getCurrentPhase }
 */
function createFriend(deps) {
    const { network, timeSync, logger, farm, notify } = deps;
    const { sendMsgAsync, getUserState } = network;
    const { getServerTimeSec } = timeSync;
    const { log, logWarn } = logger;
    const { getCurrentPhase } = farm;

    // ============ 每用户私有状态 ============
    let isCheckingFriends = false;
    let isFirstFriendCheck = true;
    let friendCheckTimer = null;

    // 操作限次跟踪
    let operationLimits = new Map();

    // 经验 delta 追踪
    const expTracker = new Map();    // opId -> 帮忙前的 dayExpTimes
    const expExhausted = new Set();  // 经验已耗尽的操作类型

    // 每日重置
    let lastResetDate = '';

    // ============ 每日重置 ============

    function getLocalDateKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function checkDailyReset() {
        const today = getLocalDateKey();
        if (lastResetDate !== today) {
            if (lastResetDate !== '') {
                log('系统', '跨日重置，清空操作限制缓存');
            }
            operationLimits.clear();
            expExhausted.clear();
            expTracker.clear();
            lastResetDate = today;
        }
    }

    // ============ 操作限次函数 ============

    function updateOperationLimits(limits) {
        if (!limits || limits.length === 0) return;
        checkDailyReset();
        for (const limit of limits) {
            const id = toNum(limit.id);
            if (id === 0) continue;
            const newExpTimes = toNum(limit.day_exp_times);
            operationLimits.set(id, {
                dayTimes: toNum(limit.day_times),
                dayTimesLimit: toNum(limit.day_times_lt),
                dayExpTimes: newExpTimes,
                dayExpTimesLimit: toNum(limit.day_ex_times_lt),
            });

            // 经验 delta 追踪：比较帮忙前后的 dayExpTimes
            if (expTracker.has(id)) {
                const prevExpTimes = expTracker.get(id);
                expTracker.delete(id);
                if (newExpTimes <= prevExpTimes && !expExhausted.has(id)) {
                    expExhausted.add(id);
                    const name = OP_NAMES[id] || `#${id}`;
                    log('限制', `${name} 经验已耗尽 (已获${newExpTimes}次)`);
                }
            }
        }
    }

    function markExpCheck(opId) {
        const limit = operationLimits.get(opId);
        if (limit) {
            expTracker.set(opId, limit.dayExpTimes);
        }
    }

    function canDoOperation(opId) {
        const info = operationLimits.get(opId);
        if (!info) return true;
        if (info.dayTimesLimit <= 0) return true;
        return info.dayTimes < info.dayTimesLimit;
    }

    function getRemainingCount(opId) {
        const info = operationLimits.get(opId);
        if (!info) return Infinity;
        if (info.dayTimesLimit <= 0) return Infinity;
        return Math.max(0, info.dayTimesLimit - info.dayTimes);
    }

    function canGetExp(opId) {
        if (expExhausted.has(opId)) return false;
        const limit = operationLimits.get(opId);
        if (!limit) return true;
        if (limit.dayExpTimesLimit > 0) {
            return limit.dayExpTimes < limit.dayExpTimesLimit;
        }
        return true; // dayExpTimesLimit=0 时依赖 delta 追踪
    }

    function logOperationLimits() {
        if (operationLimits.size === 0) return;
        const parts = [];
        for (const [opId, name] of Object.entries(OP_NAMES)) {
            const id = Number(opId);
            const info = operationLimits.get(id);
            if (!info) continue;
            const remaining = info.dayTimesLimit > 0 ? Math.max(0, info.dayTimesLimit - info.dayTimes) : '∞';
            const limitStr = info.dayTimesLimit > 0 ? info.dayTimesLimit : '∞';
            const exhausted = expExhausted.has(id);
            parts.push(`${name}:${remaining}/${limitStr}${exhausted ? '(经验满)' : ''}`);
        }
        if (parts.length > 0) {
            log('限次', `剩余次数: ${parts.join(' | ')}`);
        }
    }

    // ============ 好友 API ============

    async function getAllFriends() {
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
        return types.GetAllFriendsReply.decode(replyBody);
    }

    async function enterFriendFarm(friendGid) {
        const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
            host_gid: toLong(friendGid),
            reason: 2,
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

    async function putInsects(friendGid, landIds) {
        const body = types.PutInsectsRequest.encode(types.PutInsectsRequest.create({
            land_ids: landIds,
            host_gid: toLong(friendGid),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'PutInsects', body);
        const reply = types.PutInsectsReply.decode(replyBody);
        updateOperationLimits(reply.operation_limits);
        return reply;
    }

    async function putWeeds(friendGid, landIds) {
        const body = types.PutWeedsRequest.encode(types.PutWeedsRequest.create({
            land_ids: landIds,
            host_gid: toLong(friendGid),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'PutWeeds', body);
        const reply = types.PutWeedsReply.decode(replyBody);
        updateOperationLimits(reply.operation_limits);
        return reply;
    }

    // ============ 好友申请 API ============

    async function getApplications() {
        const body = types.GetApplicationsRequest.encode(types.GetApplicationsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetApplications', body);
        return types.GetApplicationsReply.decode(replyBody);
    }

    async function acceptFriends(gids) {
        const body = types.AcceptFriendsRequest.encode(types.AcceptFriendsRequest.create({
            friend_gids: gids.map(g => toLong(g)),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'AcceptFriends', body);
        return types.AcceptFriendsReply.decode(replyBody);
    }

    async function checkAndAcceptApplications() {
        try {
            const reply = await getApplications();
            const applications = reply.applications || [];
            if (applications.length === 0) return;

            const gids = applications.map(a => toNum(a.gid));
            const names = applications.map(a => a.name || a.remark || `GID:${toNum(a.gid)}`);
            log('好友', `发现 ${applications.length} 个待处理好友申请: ${names.join(', ')}`);

            await acceptFriends(gids);
            log('好友', `已自动接受 ${gids.length} 个好友申请`);
        } catch (e) {
            logWarn('好友', `处理好友申请失败: ${e.message}`);
        }
    }

    function onFriendApplicationReceived() {
        checkAndAcceptApplications();
    }

    // ============ 好友土地分析 ============

    function analyzeFriendLands(lands, myGid) {
        const result = { stealable: [], needWater: [], needWeed: [], needBug: [], canPutWeed: [], canPutBug: [] };

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

            // 放虫/放草判断：每块地最多2个虫/草主人，且自己没放过
            if (ENABLE_PUT_BAD_THINGS && myGid) {
                const weedOwners = plant.weed_owners || [];
                const insectOwners = plant.insect_owners || [];
                const iAlreadyPutWeed = weedOwners.some(gid => toNum(gid) === myGid);
                const iAlreadyPutBug = insectOwners.some(gid => toNum(gid) === myGid);
                if (weedOwners.length < 2 && !iAlreadyPutWeed) result.canPutWeed.push(id);
                if (insectOwners.length < 2 && !iAlreadyPutBug) result.canPutBug.push(id);
            }
        }
        return result;
    }

    // ============ 拜访好友 ============

    async function visitFriend(friend, totalActions, myGid) {
        const { gid, name, reason } = friend;
        log('拜访', `${name} (${reason})`);

        let enterReply;
        try {
            enterReply = await enterFriendFarm(gid);
        } catch (e) {
            logWarn('拜访', `进入 ${name} 农场失败: ${e.message}`);
            return;
        }

        // 从 enterReply 更新操作限次
        updateOperationLimits(enterReply.operation_limits);

        const lands = enterReply.lands || [];
        if (lands.length === 0) {
            if (isFirstFriendCheck) log('拜访', `${name}: 返回土地数为0`);
            await leaveFriendFarm(gid);
            return;
        }

        if (isFirstFriendCheck) {
            const friendName = enterReply.basic ? (enterReply.basic.name || '') : '';
            log('拜访', `${name}(${friendName}): 共 ${lands.length} 块土地`);
            for (const land of lands.slice(0, 5)) {
                const id = toNum(land.id);
                const p = land.plant;
                if (!p || !p.phases || p.phases.length === 0) {
                    log('拜访', `  土地#${id}: 无植物`);
                    continue;
                }
                const phase = getCurrentPhase(p.phases, false, '');
                const phaseName = phase ? (PHASE_NAMES[phase.phase] || `阶段${phase.phase}`) : '未知';
                log('拜访', `  土地#${id}: ${p.name||'?'} 阶段=${phaseName} dry=${toNum(p.dry_num)} weed=${(p.weed_owners||[]).length} insect=${(p.insect_owners||[]).length} stealable=${p.stealable} left_fruit=${toNum(p.left_fruit_num)}`);
            }
            if (lands.length > 5) log('拜访', `  ... 还有 ${lands.length - 5} 块`);
        }

        const status = analyzeFriendLands(lands, myGid);
        const parts = [];
        if (status.stealable.length) parts.push(`可偷:${status.stealable.length}`);
        if (status.needWater.length) parts.push(`缺水:${status.needWater.length}`);
        if (status.needWeed.length) parts.push(`有草:${status.needWeed.length}`);
        if (status.needBug.length) parts.push(`有虫:${status.needBug.length}`);
        if (status.canPutWeed.length) parts.push(`可放草:${status.canPutWeed.length}`);
        if (status.canPutBug.length) parts.push(`可放虫:${status.canPutBug.length}`);

        if (parts.length === 0) {
            log('拜访', `${name} 无需操作`);
            await leaveFriendFarm(gid);
            return;
        }
        log('拜访', `${name} 详细: ${parts.join(' | ')}`);

        // 除草（带限次和经验耗尽检测）
        if (status.needWeed.length > 0 && canDoOperation(OP_HELP_WEED)) {
            const shouldHelp = !HELP_ONLY_WITH_EXP || canGetExp(OP_HELP_WEED);
            if (shouldHelp) {
                markExpCheck(OP_HELP_WEED);
                let ok = 0, fail = 0;
                for (const landId of status.needWeed) {
                    if (!canDoOperation(OP_HELP_WEED)) break;
                    try {
                        const reply = await helpWeed(gid, [landId]);
                        updateOperationLimits(reply.operation_limits);
                        ok++;
                    } catch (e) { fail++; if (isFirstFriendCheck) log('拜访', `  除草#${landId}失败: ${e.message}`); }
                    await sleep(100);
                }
                if (ok > 0) { log('帮忙', `帮 ${name} 除草 ${ok} 块${fail > 0 ? ` (${fail}块失败)` : ''}`); totalActions.weed += ok; }
            } else {
                log('帮忙', `除草经验已满，跳过 ${name} 的除草`);
            }
        }

        // 除虫（带限次和经验耗尽检测）
        if (status.needBug.length > 0 && canDoOperation(OP_HELP_INSECT)) {
            const shouldHelp = !HELP_ONLY_WITH_EXP || canGetExp(OP_HELP_INSECT);
            if (shouldHelp) {
                markExpCheck(OP_HELP_INSECT);
                let ok = 0, fail = 0;
                for (const landId of status.needBug) {
                    if (!canDoOperation(OP_HELP_INSECT)) break;
                    try {
                        const reply = await helpInsecticide(gid, [landId]);
                        updateOperationLimits(reply.operation_limits);
                        ok++;
                    } catch (e) { fail++; if (isFirstFriendCheck) log('拜访', `  除虫#${landId}失败: ${e.message}`); }
                    await sleep(100);
                }
                if (ok > 0) { log('帮忙', `帮 ${name} 除虫 ${ok} 块${fail > 0 ? ` (${fail}块失败)` : ''}`); totalActions.bug += ok; }
            } else {
                log('帮忙', `除虫经验已满，跳过 ${name} 的除虫`);
            }
        }

        // 浇水（带限次和经验耗尽检测）
        if (status.needWater.length > 0 && canDoOperation(OP_HELP_WATER)) {
            const shouldHelp = !HELP_ONLY_WITH_EXP || canGetExp(OP_HELP_WATER);
            if (shouldHelp) {
                markExpCheck(OP_HELP_WATER);
                let ok = 0, fail = 0;
                for (const landId of status.needWater) {
                    if (!canDoOperation(OP_HELP_WATER)) break;
                    try {
                        const reply = await helpWater(gid, [landId]);
                        updateOperationLimits(reply.operation_limits);
                        ok++;
                    } catch (e) { fail++; if (isFirstFriendCheck) log('拜访', `  浇水#${landId}失败: ${e.message}`); }
                    await sleep(100);
                }
                if (ok > 0) { log('帮忙', `帮 ${name} 浇水 ${ok} 块${fail > 0 ? ` (${fail}块失败)` : ''}`); totalActions.water += ok; }
            } else {
                log('帮忙', `浇水经验已满，跳过 ${name} 的浇水`);
            }
        }

        // 偷菜（带限次检测，不受经验耗尽限制）
        if (status.stealable.length > 0 && canDoOperation(OP_STEAL)) {
            let stoleCount = 0, failCount = 0;
            for (const landId of status.stealable) {
                if (!canDoOperation(OP_STEAL)) break;
                try {
                    const reply = await stealHarvest(gid, [landId]);
                    updateOperationLimits(reply.operation_limits);
                    stoleCount++;
                } catch (e) {
                    failCount++;
                    if (isFirstFriendCheck) log('拜访', `  偷菜#${landId}失败: ${e.message}`);
                }
                await sleep(100);
            }
            if (stoleCount > 0) {
                log('偷菜', `从 ${name} 偷了 ${stoleCount} 块地${failCount > 0 ? ` (${failCount}块失败)` : ''}`);
                totalActions.steal += stoleCount;
            } else if (failCount > 0) {
                log('偷菜', `${name} 全部 ${failCount} 块偷取失败`);
            }
        }

        // 放虫（带限次检测）
        if (ENABLE_PUT_BAD_THINGS && status.canPutBug.length > 0 && canDoOperation(OP_PUT_INSECT)) {
            let ok = 0;
            const remaining = getRemainingCount(OP_PUT_INSECT);
            const toProcess = status.canPutBug.slice(0, remaining);
            for (const landId of toProcess) {
                if (!canDoOperation(OP_PUT_INSECT)) break;
                try { await putInsects(gid, [landId]); ok++; } catch (e) { /* ignore */ }
                await sleep(100);
            }
            if (ok > 0) { log('捣乱', `给 ${name} 放虫 ${ok} 块`); totalActions.putBug += ok; if (notify) notify(`🐛 给 ${name} 放虫 ${ok} 块`); }
        }

        // 放草（带限次检测）
        if (ENABLE_PUT_BAD_THINGS && status.canPutWeed.length > 0 && canDoOperation(OP_PUT_WEED)) {
            let ok = 0;
            const remaining = getRemainingCount(OP_PUT_WEED);
            const toProcess = status.canPutWeed.slice(0, remaining);
            for (const landId of toProcess) {
                if (!canDoOperation(OP_PUT_WEED)) break;
                try { await putWeeds(gid, [landId]); ok++; } catch (e) { /* ignore */ }
                await sleep(100);
            }
            if (ok > 0) { log('捣乱', `给 ${name} 放草 ${ok} 块`); totalActions.putWeed += ok; if (notify) notify(`🌿 给 ${name} 放草 ${ok} 块`); }
        }

        await leaveFriendFarm(gid);
    }

    // ============ 好友巡查主循环 ============

    async function checkFriends() {
        const state = getUserState();
        if (isCheckingFriends || !state.gid) return;
        isCheckingFriends = true;

        checkDailyReset();

        try {
            const friendsReply = await getAllFriends();
            const friends = friendsReply.game_friends || [];
            if (friends.length === 0) { log('好友', '没有好友'); return; }
            log('好友', `共 ${friends.length} 位好友，开始巡查...`);

            // 输出操作限次信息
            logOperationLimits();

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

            // 放虫放草：即使好友状态摘要无需操作也要拜访（好友列表不展示放虫放草信息）
            if (ENABLE_PUT_BAD_THINGS) {
                for (const f of friends) {
                    const gid = toNum(f.gid);
                    if (gid === state.gid) continue;
                    if (visitedGids.has(gid)) continue;
                    const name = f.remark || f.name || `GID:${gid}`;
                    friendsToVisit.push({ gid, name, reason: '放虫放草' });
                    visitedGids.add(gid);
                }
            }

            if (friendsToVisit.length === 0) { log('好友', '所有好友农场无需操作'); return; }
            log('好友', `${friendsToVisit.length} 位好友需要拜访`);

            let totalActions = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
            for (const friend of friendsToVisit) {
                try { await visitFriend(friend, totalActions, state.gid); } catch (e) { logWarn('好友', `拜访 ${friend.name} 失败: ${e.message}`); }
                await sleep(500);
            }

            const summary = [];
            if (totalActions.steal > 0) summary.push(`偷菜:${totalActions.steal}块`);
            if (totalActions.water > 0) summary.push(`浇水:${totalActions.water}块`);
            if (totalActions.weed > 0) summary.push(`除草:${totalActions.weed}块`);
            if (totalActions.bug > 0) summary.push(`除虫:${totalActions.bug}块`);
            if (totalActions.putBug > 0) summary.push(`放虫:${totalActions.putBug}块`);
            if (totalActions.putWeed > 0) summary.push(`放草:${totalActions.putWeed}块`);
            log('好友', `巡查完毕! ${summary.length > 0 ? summary.join(' | ') : '无操作'}`);
            if (summary.length > 0 && notify) {
                const header = `👥 好友巡查完毕 (${friendsToVisit.length}/${friends.length})`;
                notify(`${header}\n${summary.join(' | ')}`);
            }
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

    return {
        checkFriends, startFriendCheckLoop, stopFriendCheckLoop,
        checkAndAcceptApplications, onFriendApplicationReceived,
    };
}

module.exports = { createFriend };
