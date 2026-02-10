/**
 * QQ经典农场 挂机脚本 - 入口文件 (多用户版)
 *
 * 模块结构:
 *   src/config.js          - 配置常量与枚举
 *   src/utils.js           - 通用工具函数与工厂
 *   src/proto.js           - Protobuf 加载与类型管理
 *   src/network.js         - WebSocket 连接/消息编解码/登录/心跳
 *   src/farm.js            - 自己农场操作与巡田循环
 *   src/friend.js          - 好友农场操作与巡查循环
 *   src/session.js         - 用户会话编排器
 *   src/session-manager.js - 动态会话管理器
 *   src/telegram.js        - Telegram Bot API 客户端
 *   src/decode.js          - PB解码/验证工具模式
 */

const { CONFIG } = require('./src/config');
const { loadProto } = require('./src/proto');
const { createSession } = require('./src/session');
const { verifyMode, decodeMode } = require('./src/decode');
const { sleep, createLogger } = require('./src/utils');
const { createTelegramBot } = require('./src/telegram');
const { createSessionManager } = require('./src/session-manager');

// ============ 帮助信息 ============
function showHelp() {
    console.log(`
QQ经典农场 挂机脚本 (多用户版)
================================

用法:
  bun client.js --code <登录code>
  bun client.js --codes <code1,code2,code3>
  bun client.js --verify
  bun client.js --decode <数据> [--hex] [--gate] [--type <消息类型>]

参数:
  --code              单用户模式: 一个登录code
  --codes             多用户模式: 逗号分隔的多个code
  --interval          自己农场巡查间隔秒数, 默认30秒, 最低10秒
  --friend-interval   好友农场巡查间隔秒数, 默认60秒(1分钟), 最低60秒
  --verify            验证proto定义
  --decode            解码PB数据 (运行 --decode 无参数查看详细帮助)

环境变量 (.env):
  FARM_CODE           单用户模式 (向后兼容)
  FARM_CODES          多用户模式 (逗号分隔)
  FARM_INTERVAL       自己农场巡查间隔秒数
  FRIEND_INTERVAL     好友农场巡查间隔秒数
  TELEGRAM_BOT_TOKEN  Telegram 机器人 Token (可选)
  TELEGRAM_CHAT_ID    Telegram 管理员 Chat ID (可选)

功能:
  - 自动收获成熟作物 → 购买种子 → 种植
  - 自动除草、除虫、浇水
  - 自动铲除枯死作物
  - 自动巡查好友农场: 帮忙浇水/除草/除虫 + 偷菜
  - 心跳保活
  - 多用户并行挂机
  - Telegram 机器人: 动态添加用户、状态查询、失效通知
`);
}

// ============ 参数解析 ============
function parseArgs(args) {
    let codes = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--code' && args[i + 1]) {
            codes.push(args[++i]);
        }
        if (args[i] === '--codes' && args[i + 1]) {
            codes.push(...args[++i].split(',').map(s => s.trim()).filter(Boolean));
        }
        if (args[i] === '--interval' && args[i + 1]) {
            const sec = parseInt(args[++i]);
            CONFIG.farmCheckInterval = Math.max(sec, 10) * 1000;
        }
        if (args[i] === '--friend-interval' && args[i + 1]) {
            const sec = parseInt(args[++i]);
            CONFIG.friendCheckInterval = Math.max(sec, 60) * 1000;
        }
    }

    // 环境变量回退
    if (codes.length === 0 && process.env.FARM_CODES) {
        codes = process.env.FARM_CODES.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (codes.length === 0 && process.env.FARM_CODE) {
        codes.push(process.env.FARM_CODE);
    }

    // interval 也支持环境变量
    if (process.env.FARM_INTERVAL && CONFIG.farmCheckInterval === 30000) {
        const sec = parseInt(process.env.FARM_INTERVAL);
        if (!isNaN(sec)) CONFIG.farmCheckInterval = Math.max(sec, 10) * 1000;
    }
    if (process.env.FRIEND_INTERVAL && CONFIG.friendCheckInterval === 60000) {
        const sec = parseInt(process.env.FRIEND_INTERVAL);
        if (!isNaN(sec)) CONFIG.friendCheckInterval = Math.max(sec, 60) * 1000;
    }

    return [...new Set(codes)];
}

// ============ Telegram 消息处理 ============
function handleTelegramMessage(text, chatId, sessionManager, telegram) {
    const trimmed = text.trim();

    if (trimmed.startsWith('/code')) {
        const payload = trimmed.substring('/code'.length);
        const code = sessionManager.extractCode(payload);
        if (!code) {
            telegram.sendMessage('⚠️ 未找到有效的 code\n\n请发送包含 code 参数的 HTTP 请求报文，例如:\n/code\nGET /prod/ws?code=3a6dfd97f78ab9995ea7ba857ade8bc6&... HTTP/1.1');
            return;
        }
        const result = sessionManager.addSession(code);
        telegram.sendMessage(result.success ? `🚀 ${result.message}` : `⚠️ ${result.message}`);
        return;
    }

    if (trimmed === '/status') {
        const list = sessionManager.getSessionList();
        if (list.length === 0) {
            telegram.sendMessage('📋 当前没有活跃会话');
            return;
        }
        const lines = list.map((s, i) =>
            `${i + 1}. ${s.userName} (${s.code}) - ${s.status}`
        );
        telegram.sendMessage(`📋 活跃会话 (${list.length})\n\n${lines.join('\n')}`);
        return;
    }

    if (trimmed === '/stop') {
        const count = sessionManager.getSessionCount();
        sessionManager.stopAll();
        telegram.sendMessage(`🛑 已停止全部 ${count} 个会话`);
        return;
    }

    // 未知命令，返回帮助
    telegram.sendMessage(
        '📖 可用命令:\n\n' +
        '/code + HTTP报文 - 添加新用户会话\n' +
        '/status - 查看当前会话状态\n' +
        '/stop - 停止所有会话'
    );
}

// ============ 主函数 ============
async function main() {
    const args = process.argv.slice(2);

    // 加载 proto 定义
    await loadProto();

    // 验证模式
    if (args.includes('--verify')) {
        await verifyMode();
        return;
    }

    // 解码模式
    if (args.includes('--decode')) {
        await decodeMode(args);
        return;
    }

    // 正常挂机模式
    const codes = parseArgs(args);
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const hasTelegram = botToken && chatId;

    // 无 code 且无 Telegram 时显示帮助
    if (codes.length === 0 && !hasTelegram) {
        showHelp();
        process.exit(1);
    }

    console.log(`[配置] 农场检查间隔: ${CONFIG.farmCheckInterval / 1000}秒`);
    console.log(`[配置] 好友检查间隔: ${CONFIG.friendCheckInterval / 1000}秒`);

    // 初始化 Telegram（可选）
    const mainLogger = createLogger('主控');
    let telegram = null;
    if (hasTelegram) {
        telegram = createTelegramBot({ token: botToken, chatId, logger: mainLogger });
        console.log('[TG] Telegram 机器人已启用');
    }

    // 创建会话管理器
    const sessionManager = createSessionManager({ telegram, logger: mainLogger });

    // 从 CLI/ENV 加载初始 codes
    if (codes.length > 0) {
        console.log(`\n[启动] 共 ${codes.length} 个初始用户`);
        for (let i = 0; i < codes.length; i++) {
            sessionManager.addSession(codes[i]);
            if (i < codes.length - 1) {
                await sleep(2000);
            }
        }
    }

    // 启动 Telegram long-polling
    if (telegram) {
        if (codes.length === 0) {
            console.log('\n[TG] 等待 Telegram 消息添加用户...');
        }
        telegram.sendMessage('🤖 农场机器人已启动\n发送 /status 查看状态');
        telegram.startPolling((text, msgChatId) => {
            handleTelegramMessage(text, msgChatId, sessionManager, telegram);
        });
    }

    // 退出处理
    process.on('SIGINT', () => {
        console.log('\n[退出] 正在关闭所有会话...');
        sessionManager.stopAll();
        if (telegram) telegram.stopPolling();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
});
