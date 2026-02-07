# QQ经典农场 挂机脚本

基于 Node.js 的 QQ 经典农场小程序自动化挂机脚本。通过分析小程序 WebSocket 通信协议（Protocol Buffers），实现全自动农场管理。

## 功能

- **自动收获** — 检测成熟作物并自动收获
- **自动种植** — 收获/铲除后自动购买当前等级最高种子并种植
- **自动除草** — 检测并清除杂草
- **自动除虫** — 检测并消灭害虫
- **自动浇水** — 检测缺水作物并浇水
- **自动铲除** — 自动铲除枯死作物
- **好友巡查** — 自动巡查好友农场，帮忙浇水/除草/除虫 + 偷菜
- **心跳保活** — 自动维持 WebSocket 连接
- **PB 解码工具** — 内置 Protobuf 数据解码器，方便调试分析

## 安装

```bash
git clone https://github.com/linguo2625469/qq-farm-bot.git
cd qq-farm-bot
npm install
```

### 依赖

- [ws](https://www.npmjs.com/package/ws) — WebSocket 客户端
- [protobufjs](https://www.npmjs.com/package/protobufjs) — Protocol Buffers 编解码
- [long](https://www.npmjs.com/package/long) — 64 位整数支持

## 使用

### 获取登录 Code

你需要从小程序中抓取code。可以通过抓包工具（如 Fiddler、Charles、mitmproxy 等）获取 WebSocket 连接 URL 中的 `code` 参数。

### 启动挂机

```bash
node client.js --code <你的登录code>
```

例如
```bash
node client.js --code 1234567890qwertyuiop
```

### 自定义巡查间隔

```bash
# 农场巡查间隔 60 秒，好友巡查间隔 180 秒
node client.js --code <code> --interval 60 --friend-interval 180
```

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--code` | 小程序登录凭证（**必需**） | — |
| `--interval` | 自己农场巡查间隔（秒） | 30（最低 10） |
| `--friend-interval` | 好友农场巡查间隔（秒） | 60（最低 60） |
| `--verify` | 验证 proto 定义是否正确 | — |
| `--decode` | 进入 PB 数据解码模式 | — |

### PB 解码工具

内置 Protobuf 数据解码器，支持自动推断消息类型：

```bash
# 解码 base64 格式的 gatepb.Message
node client.js --decode CigKGWdhbWVwYi... --gate

# 解码 hex 格式，指定消息类型
node client.js --decode 0a1c0a19... --hex --type gatepb.Message

# 解码 base64 格式，指定消息类型
node client.js --decode <base64数据> --type gamepb.plantpb.AllLandsReply

# 查看解码工具详细帮助
node client.js --decode
```

## 项目结构

```
├── client.js              # 入口文件 - 参数解析与启动调度
├── src/
│   ├── config.js          # 配置常量与生长阶段枚举
│   ├── utils.js           # 工具函数 (类型转换/日志/时间同步/sleep)
│   ├── proto.js           # Protobuf 加载与消息类型管理
│   ├── network.js         # WebSocket 连接/消息编解码/登录/心跳
│   ├── farm.js            # 自己农场: 收获/浇水/除草/除虫/铲除/种植/商店/巡田
│   ├── friend.js          # 好友农场: 进入/帮忙/偷菜/巡查循环
│   └── decode.js          # PB 解码/验证工具模式
├── proto/
│   ├── game.proto         # 网关消息定义 (gatepb)
│   ├── userpb.proto       # 用户/登录/心跳消息
│   ├── plantpb.proto      # 农场/土地/植物消息
│   ├── corepb.proto       # 通用 Item 消息
│   ├── shoppb.proto       # 商店消息
│   ├── friendpb.proto     # 好友列表消息
│   └── visitpb.proto      # 好友农场拜访消息
└── package.json
```

## 运行示例

```
[启动] 使用code: 0c1a2b3c...
[配置] 农场检查间隔: 30秒
[配置] 好友检查间隔: 60秒

[22:30:01] [WS] 连接成功
[22:30:01] [Proto] 所有协议定义加载成功

========== 登录成功 ==========
  GID:    1234567890
  昵称:   我的农场
  等级:   15
  金币:   8888
  时间:   2026/2/7 22:30:01
===============================

[22:30:03] [巡田] 可收获:4(1,2,3,4) | 生长中:8 | 缺水:2(5,6)
[22:30:03] [浇水] 已浇水 2 块地 (5,6)
[22:30:04] [收获] 已收获 4 块地 (1,2,3,4)
[22:30:05] [商店] 最佳种子: goods_id=12 item_id=1001 价格=100金币
[22:30:05] [购买] 已购买种子x4, 花费 400 金币
[22:30:06] [种植] 已在 4 块地种植 (1,2,3,4)
[22:30:10] [好友] 共 15 位好友，开始巡查...
[22:30:11] [拜访] 小明 (可偷:2 有草:1)
[22:30:12] [帮忙] 帮 小明 除草 1 块
[22:30:12] [偷菜] 从 小明 偷了 2 块地
[22:30:15] [好友] 巡查完毕! 偷菜:2块 | 除草:1块
```


## 免责声明

本项目仅供学习和研究用途。使用本脚本可能违反游戏服务条款，由此产生的一切后果由使用者自行承担。

## License

MIT
