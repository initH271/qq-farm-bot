/**
 * 动态会话管理器 - 管理多个用户会话的生命周期与失败检测
 */

const { createSession } = require('./session');

const CODE_REGEX = /[?&]code=([a-fA-F0-9]{32})\b/;

/**
 * 从文本中提取 code
 * @param {string} text
 * @returns {string|null}
 */
function extractCode(text) {
    const match = text.match(CODE_REGEX);
    return match ? match[1] : null;
}

/**
 * 创建会话管理器
 * @param {Object} opts
 * @param {Object} opts.telegram - Telegram bot 实例（可选）
 * @param {Object} opts.logger - { log, logWarn }
 */
function createSessionManager({ telegram, logger }) {
    // Map<code, { session, failureCount, userName, status }>
    const sessions = new Map();

    function notify(text) {
        if (telegram) telegram.sendMessage(text);
    }

    /**
     * 创建网络事件处理器
     * @param {string} code
     */
    function createEventHandler(code) {
        return function onEvent(event) {
            const entry = sessions.get(code);
            if (!entry) return;

            switch (event.type) {
                case 'login_success':
                    entry.failureCount = 0;
                    entry.userName = event.userState.name || '未知';
                    entry.status = 'online';
                    notify(`✅ 登录成功\n用户: ${entry.userName}\nCode: ${code.substring(0, 8)}...`);
                    break;

                case 'ws_close':
                    logger.log('会话', `${entry.userName || code.substring(0, 8)} WS 连接关闭`);
                    entry.status = 'disconnected';
                    removeSession(code);
                    notify(`❌ 连接断开\n用户: ${entry.userName || '未知'}\nCode: ${code.substring(0, 8)}...\n原因: WebSocket 关闭 (code=${event.closeCode})`);
                    break;

                case 'kickout':
                    logger.log('会话', `${entry.userName || code.substring(0, 8)} 被踢下线`);
                    entry.status = 'kicked';
                    removeSession(code);
                    notify(`❌ 被踢下线\n用户: ${entry.userName || '未知'}\nCode: ${code.substring(0, 8)}...\n原因: 服务器踢出`);
                    break;

                case 'timeout':
                    entry.failureCount++;
                    logger.log('会话', `${entry.userName || code.substring(0, 8)} 超时 (${entry.failureCount}/3)`);
                    if (entry.failureCount >= 3) {
                        entry.status = 'timeout';
                        removeSession(code);
                        notify(`❌ 连接超时\n用户: ${entry.userName || '未知'}\nCode: ${code.substring(0, 8)}...\n原因: 连续 ${entry.failureCount} 次超时`);
                    }
                    break;
            }
        };
    }

    /**
     * 添加并启动新会话
     * @param {string} code
     * @returns {{ success: boolean, message: string }}
     */
    function addSession(code) {
        if (sessions.has(code)) {
            return { success: false, message: '该 code 已存在活跃会话' };
        }

        const label = `U${sessions.size + 1}`;
        const onEvent = createEventHandler(code);
        const userNotify = (text) => notify(`[${label}] ${text}`);
        const session = createSession(code, label, onEvent, userNotify);

        sessions.set(code, {
            session,
            failureCount: 0,
            userName: '',
            status: 'connecting',
        });

        session.start();
        logger.log('会话', `已添加 code=${code.substring(0, 8)}... (当前共 ${sessions.size} 个)`);

        return { success: true, message: `会话已创建，正在连接... (code=${code.substring(0, 8)}...)` };
    }

    /**
     * 停止并移除指定会话
     * @param {string} code
     */
    function removeSession(code) {
        const entry = sessions.get(code);
        if (!entry) return;

        try {
            entry.session.stop();
        } catch (e) {}

        sessions.delete(code);
        logger.log('会话', `已移除 code=${code.substring(0, 8)}... (剩余 ${sessions.size} 个)`);
    }

    function getSessionCount() {
        return sessions.size;
    }

    function getSessionList() {
        const list = [];
        for (const [code, entry] of sessions) {
            list.push({
                code: code.substring(0, 8) + '...',
                userName: entry.userName || '未知',
                status: entry.status,
                failureCount: entry.failureCount,
            });
        }
        return list;
    }

    function stopAll() {
        for (const [code, entry] of sessions) {
            try {
                entry.session.stop();
            } catch (e) {}
        }
        sessions.clear();
        logger.log('会话', '已停止所有会话');
    }

    return {
        addSession,
        removeSession,
        getSessionCount,
        getSessionList,
        stopAll,
        extractCode,
    };
}

module.exports = { createSessionManager, extractCode };
