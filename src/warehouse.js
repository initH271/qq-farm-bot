/**
 * 仓库系统 - 自动出售果实（工厂模式）
 * 协议说明：BagReply 使用 item_bag（ItemBag），item_bag.items 才是背包物品列表
 */

const { types } = require('./proto');
const { toLong, toNum, sleep } = require('./utils');
const { getFruitName } = require('./gameConfig');

// 果实 ID 范围
const FRUIT_ID_MIN = 3001;
const FRUIT_ID_MAX = 49999;

// 单次 Sell 请求最多条数
const SELL_BATCH_SIZE = 15;

/**
 * 创建仓库系统实例
 * @param {Object} deps
 * @param {Object} deps.network - { sendMsgAsync }
 * @param {Object} deps.logger  - { log, logWarn }
 */
function createWarehouse(deps) {
    const { network, logger } = deps;
    const { sendMsgAsync } = network;
    const { log, logWarn } = logger;

    let sellTimer = null;
    let sellIntervalTimer = null;

    // ============ 仓库 API ============

    async function getBag() {
        const body = types.BagRequest.encode(types.BagRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Bag', body);
        return types.BagReply.decode(replyBody);
    }

    function toSellItem(item) {
        const id = item.id != null ? toLong(item.id) : undefined;
        const count = item.count != null ? toLong(item.count) : undefined;
        const uid = item.uid != null ? toLong(item.uid) : undefined;
        return { id, count, uid };
    }

    async function sellItems(items) {
        const payload = items.map(toSellItem);
        const body = types.SellRequest.encode(types.SellRequest.create({ items: payload })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Sell', body);
        return types.SellReply.decode(replyBody);
    }

    function getBagItems(bagReply) {
        if (bagReply.item_bag && bagReply.item_bag.items && bagReply.item_bag.items.length)
            return bagReply.item_bag.items;
        return bagReply.items || [];
    }

    // ============ 自动出售 ============

    async function sellAllFruits() {
        try {
            const bagReply = await getBag();
            const items = getBagItems(bagReply);

            const toSell = [];
            const names = [];
            for (const item of items) {
                const id = toNum(item.id);
                const count = toNum(item.count);
                const uid = item.uid ? toNum(item.uid) : 0;

                if (id >= FRUIT_ID_MIN && id <= FRUIT_ID_MAX && count > 0) {
                    if (uid === 0) {
                        logWarn('仓库', `跳过无效物品: ID=${id} Count=${count} (UID丢失)`);
                        continue;
                    }
                    toSell.push(item);
                    names.push(`${getFruitName(id)}x${count}`);
                }
            }

            if (toSell.length === 0) return;

            let totalGold = 0;
            for (let i = 0; i < toSell.length; i += SELL_BATCH_SIZE) {
                const batch = toSell.slice(i, i + SELL_BATCH_SIZE);
                const reply = await sellItems(batch);
                totalGold += toNum(reply.gold || 0);
                if (i + SELL_BATCH_SIZE < toSell.length) await sleep(300);
            }
            log('仓库', `出售 ${names.join(', ')}，获得 ${totalGold} 金币`);
        } catch (e) {
            logWarn('仓库', `出售失败: ${e.message}`);
        }
    }

    // ============ 生命周期 ============

    function startSellLoop(interval = 60000) {
        if (sellIntervalTimer) return;
        sellTimer = setTimeout(() => {
            sellAllFruits();
            sellIntervalTimer = setInterval(() => sellAllFruits(), interval);
        }, 10000);
    }

    function stopSellLoop() {
        if (sellTimer) {
            clearTimeout(sellTimer);
            sellTimer = null;
        }
        if (sellIntervalTimer) {
            clearInterval(sellIntervalTimer);
            sellIntervalTimer = null;
        }
    }

    return {
        getBag,
        sellItems,
        sellAllFruits,
        getBagItems,
        startSellLoop,
        stopSellLoop,
    };
}

module.exports = { createWarehouse };
