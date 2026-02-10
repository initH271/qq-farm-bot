/**
 * Telegram Bot API 客户端 - 使用 Bun 内置 fetch，零依赖
 */

/**
 * 创建 Telegram Bot 实例
 * @param {Object} opts
 * @param {string} opts.token - Bot API Token
 * @param {string} opts.chatId - 允许的 Chat ID
 * @param {Object} opts.logger - { log, logWarn }
 */
function createTelegramBot({ token, chatId, logger }) {
    const baseUrl = `https://api.telegram.org/bot${token}`;
    let running = false;
    let abortController = null;

    async function sendMessage(text) {
        try {
            const resp = await fetch(`${baseUrl}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text,
                    parse_mode: 'HTML',
                }),
            });
            if (!resp.ok) {
                logger.logWarn('TG', `发送消息失败: ${resp.status} ${resp.statusText}`);
            }
        } catch (err) {
            logger.logWarn('TG', `发送消息异常: ${err.message}`);
        }
    }

    /**
     * 开始 long-polling 循环
     * @param {(text: string, chatId: string) => void} onMessage
     */
    async function startPolling(onMessage) {
        running = true;
        let offset = 0;
        logger.log('TG', 'Long-polling 已启动');

        while (running) {
            try {
                abortController = new AbortController();
                const resp = await fetch(`${baseUrl}/getUpdates?offset=${offset}&timeout=30`, {
                    signal: abortController.signal,
                });

                if (!resp.ok) {
                    logger.logWarn('TG', `getUpdates 失败: ${resp.status}`);
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                const data = await resp.json();
                if (!data.ok || !data.result) continue;

                for (const update of data.result) {
                    offset = update.update_id + 1;
                    const msg = update.message;
                    if (!msg || !msg.text) continue;

                    // 安全限制：只处理来自配置 chatId 的消息
                    const msgChatId = String(msg.chat.id);
                    if (msgChatId !== String(chatId)) continue;

                    try {
                        onMessage(msg.text, msgChatId);
                    } catch (err) {
                        logger.logWarn('TG', `消息处理异常: ${err.message}`);
                    }
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    // stopPolling 触发的中断，正常退出
                    break;
                }
                logger.logWarn('TG', `Polling 异常: ${err.message}`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }

        logger.log('TG', 'Long-polling 已停止');
    }

    function stopPolling() {
        running = false;
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    }

    return { sendMessage, startPolling, stopPolling };
}

module.exports = { createTelegramBot };
