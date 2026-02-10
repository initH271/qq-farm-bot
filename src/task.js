/**
 * 任务系统 - 自动领取任务奖励（工厂模式）
 */

const { types } = require('./proto');
const { toLong, toNum, sleep } = require('./utils');

/**
 * 创建任务系统实例
 * @param {Object} deps
 * @param {Object} deps.network - { sendMsgAsync }
 * @param {Object} deps.logger  - { log, logWarn }
 */
function createTask(deps) {
    const { network, logger } = deps;
    const { sendMsgAsync } = network;
    const { log, logWarn } = logger;

    let taskCheckTimer = null;

    // ============ 任务 API ============

    async function getTaskInfo() {
        const body = types.TaskInfoRequest.encode(types.TaskInfoRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'TaskInfo', body);
        return types.TaskInfoReply.decode(replyBody);
    }

    async function claimTaskReward(taskId, doShared = false) {
        const body = types.ClaimTaskRewardRequest.encode(types.ClaimTaskRewardRequest.create({
            id: toLong(taskId),
            do_shared: doShared,
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimTaskReward', body);
        return types.ClaimTaskRewardReply.decode(replyBody);
    }

    async function batchClaimTaskReward(taskIds, doShared = false) {
        const body = types.BatchClaimTaskRewardRequest.encode(types.BatchClaimTaskRewardRequest.create({
            ids: taskIds.map(id => toLong(id)),
            do_shared: doShared,
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'BatchClaimTaskReward', body);
        return types.BatchClaimTaskRewardReply.decode(replyBody);
    }

    // ============ 任务分析 ============

    function analyzeTaskList(tasks) {
        const claimable = [];
        for (const task of tasks) {
            const id = toNum(task.id);
            const progress = toNum(task.progress);
            const totalProgress = toNum(task.total_progress);
            const isClaimed = task.is_claimed;
            const isUnlocked = task.is_unlocked;
            const shareMultiple = toNum(task.share_multiple);

            if (isUnlocked && !isClaimed && progress >= totalProgress && totalProgress > 0) {
                claimable.push({
                    id,
                    desc: task.desc || `任务#${id}`,
                    shareMultiple,
                    rewards: task.rewards || [],
                });
            }
        }
        return claimable;
    }

    function getRewardSummary(items) {
        const summary = [];
        for (const item of items) {
            const id = toNum(item.id);
            const count = toNum(item.count);
            if (id === 1) summary.push(`金币${count}`);
            else if (id === 2) summary.push(`经验${count}`);
            else summary.push(`物品#${id}x${count}`);
        }
        return summary.join('/');
    }

    // ============ 自动领取 ============

    async function checkAndClaimTasks() {
        try {
            const reply = await getTaskInfo();
            if (!reply.task_info) return;

            const taskInfo = reply.task_info;
            const allTasks = [
                ...(taskInfo.growth_tasks || []),
                ...(taskInfo.daily_tasks || []),
                ...(taskInfo.tasks || []),
            ];

            const claimable = analyzeTaskList(allTasks);
            if (claimable.length === 0) return;

            log('任务', `发现 ${claimable.length} 个可领取任务`);

            for (const task of claimable) {
                try {
                    const useShare = task.shareMultiple > 1;
                    const multipleStr = useShare ? ` (${task.shareMultiple}倍)` : '';

                    const claimReply = await claimTaskReward(task.id, useShare);
                    const items = claimReply.items || [];
                    const rewardStr = items.length > 0 ? getRewardSummary(items) : '无';

                    log('任务', `领取: ${task.desc}${multipleStr} → ${rewardStr}`);
                    await sleep(300);
                } catch (e) {
                    logWarn('任务', `领取失败 #${task.id}: ${e.message}`);
                }
            }
        } catch (e) {
            // 静默失败
        }
    }

    /**
     * 处理任务状态变化推送
     */
    function onTaskNotify(taskInfo) {
        if (!taskInfo) return;

        const allTasks = [
            ...(taskInfo.growth_tasks || []),
            ...(taskInfo.daily_tasks || []),
            ...(taskInfo.tasks || []),
        ];

        const claimable = analyzeTaskList(allTasks);
        if (claimable.length === 0) return;

        log('任务', `有 ${claimable.length} 个任务可领取，准备自动领取...`);
        setTimeout(() => claimTasksFromList(claimable), 1000);
    }

    async function claimTasksFromList(claimable) {
        for (const task of claimable) {
            try {
                const useShare = task.shareMultiple > 1;
                const multipleStr = useShare ? ` (${task.shareMultiple}倍)` : '';

                const claimReply = await claimTaskReward(task.id, useShare);
                const items = claimReply.items || [];
                const rewardStr = items.length > 0 ? getRewardSummary(items) : '无';

                log('任务', `领取: ${task.desc}${multipleStr} → ${rewardStr}`);
                await sleep(300);
            } catch (e) {
                logWarn('任务', `领取失败 #${task.id}: ${e.message}`);
            }
        }
    }

    // ============ 生命周期 ============

    function startTaskCheck() {
        taskCheckTimer = setTimeout(() => checkAndClaimTasks(), 4000);
    }

    function stopTaskCheck() {
        if (taskCheckTimer) {
            clearTimeout(taskCheckTimer);
            taskCheckTimer = null;
        }
    }

    return {
        getTaskInfo,
        claimTaskReward,
        batchClaimTaskReward,
        analyzeTaskList,
        checkAndClaimTasks,
        onTaskNotify,
        startTaskCheck,
        stopTaskCheck,
    };
}

module.exports = { createTask };
