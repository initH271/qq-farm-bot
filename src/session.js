/**
 * 用户会话编排器 - 组装各模块实例，管理单个用户的完整生命周期
 */

const { createTimeSync, createLogger } = require('./utils');
const { createNetwork } = require('./network');
const { createFarm } = require('./farm');
const { createFriend } = require('./friend');
const { createTask } = require('./task');
const { createWarehouse } = require('./warehouse');

/**
 * 创建一个完整的用户会话
 * @param {string} code - 登录凭证
 * @param {string} [label] - 日志标识（可选，默认用 code 前8位）
 * @param {Function} [onEvent] - 网络事件回调（可选）
 */
function createSession(code, label, onEvent) {
    const prefix = label || code.substring(0, 8);

    const timeSync = createTimeSync();
    const logger = createLogger(prefix);

    // 包装 onEvent，拦截 task_notify 事件转发给 task 模块
    let task = null;
    function wrappedOnEvent(event) {
        if (event.type === 'task_notify' && task) {
            task.onTaskNotify(event.taskInfo);
        }
        if (onEvent) onEvent(event);
    }

    const network = createNetwork({ timeSync, logger, onEvent: wrappedOnEvent });
    const farm = createFarm({ network, timeSync, logger });
    const friend = createFriend({ network, timeSync, logger, farm });
    task = createTask({ network, logger });
    const warehouse = createWarehouse({ network, logger });

    return {
        code,
        network,

        start() {
            logger.log('启动', `使用code: ${code.substring(0, 8)}...`);
            network.connect(code, () => {
                farm.startFarmCheckLoop();
                friend.startFriendCheckLoop();
                task.startTaskCheck();
                warehouse.startSellLoop(60000);
            });
        },

        stop() {
            logger.log('退出', '正在断开...');
            farm.stopFarmCheckLoop();
            friend.stopFriendCheckLoop();
            task.stopTaskCheck();
            warehouse.stopSellLoop();
            network.cleanup();
            const ws = network.getWs();
            if (ws) ws.close();
        },
    };
}

module.exports = { createSession };
