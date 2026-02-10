/**
 * 用户会话编排器 - 组装各模块实例，管理单个用户的完整生命周期
 */

const { createTimeSync, createLogger } = require('./utils');
const { createNetwork } = require('./network');
const { createFarm } = require('./farm');
const { createFriend } = require('./friend');

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
    const network = createNetwork({ timeSync, logger, onEvent });
    const farm = createFarm({ network, timeSync, logger });
    const friend = createFriend({ network, timeSync, logger, farm });

    return {
        code,
        network,

        start() {
            logger.log('启动', `使用code: ${code.substring(0, 8)}...`);
            network.connect(code, () => {
                farm.startFarmCheckLoop();
                friend.startFriendCheckLoop();
            });
        },

        stop() {
            logger.log('退出', '正在断开...');
            farm.stopFarmCheckLoop();
            friend.stopFriendCheckLoop();
            network.cleanup();
            const ws = network.getWs();
            if (ws) ws.close();
        },
    };
}

module.exports = { createSession };
