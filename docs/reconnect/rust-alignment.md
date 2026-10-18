# v1.1 协议与 Rust 信令端对齐清单（P1 · 下一期 M3 迭代承接）

| 项 | 内容 |
|---|---|
| 状态 | **P1 待办**（本期不实施） |
| 决策依据 | `docs/reconnect/architecture.md` §12 回签 **Q-C**（主理人 Qi · 2026-10-17） |
| 唯一契约源 | `packages/shared/src/types.ts` |
| 本期范围 | `apps/signaling-rust/**` **零改动**（`git status` 必须为空） |
| 承接方 | 下一期 M3 迭代（Rust 信令服务器） |

---

## 0. 为什么现在不改，也不会出问题

Node 信令服务端（`apps/server/src/server.ts`）本期已实现完整 v1.1；Rust 端仍是 v1。
新客户端连到 v1 Rust 端时的行为是**已设计并已实现**的降级路径，不会报错、不会死循环：

| 场景 | 新客户端发出的 v1.1 消息 | v1 Rust 端响应 | 新客户端行为 |
|---|---|---|---|
| 应用层心跳 | `{t:'ping', ts}` | `classify` 落 `UnknownType` → `{t:'error', message:'未知消息类型'}` | `wsTransport` 识别该文案且「刚发过 ping」→ emit `probe-unsupported{probe:'ping'}` → **关闭 L2 心跳**，只保留 L1（`onclose/onerror`）+ L3（PC/DC） |
| 重连占座 | `{t:'resume', room, peerId, token}` | 同上 → `error:'未知消息类型'` | emit `probe-unsupported{probe:'resume'}` → `serverCompat='v1'`，记 1 条 `conn.compat{server:'v1'}`，**不再尝试 resume**，降级为 `join` 重新进房 + 全量重建 PC |
| 断线通知 | — | v1 立即广播 `peer-left` | 新客户端按「对手真的走了」处理（`PEER_GONE`），可接受 |
| 座位凭证 | — | `created`/`joined` 无 `token` | `token?` 为可选字段，缺失时只影响 resume 能力，不影响建连 |

> 结论：**兼容性靠客户端单向降级解决**，不需要 Rust 端配合，也不需要双端同时上线。

---

## 1. `src/protocol/mod.rs` —— `ServerMsg` 需新增/扩展的变体

当前 `ServerMsg` 只有 6 个变体（`Created` / `Joined` / `PeerJoined` / `PeerLeft` / `Signal` / `Error`），
需按 `types.ts` 补齐 **4 个新变体 + 3 处可选字段**：

```rust
// 1) 新增：应用层心跳应答
//    对应 TS: ServerPongMsg { t:'pong'; ts?: number }
Pong { #[serde(rename = "ts", skip_serializing_if = "Option::is_none")] ts: Option<f64> },

// 2) 新增：对手掉线，进入宽限期（替代「立即 peer-left」）
//    对应 TS: ServerPeerOfflineMsg { t:'peer-offline'; graceSec: number }
PeerOffline { #[serde(rename = "graceSec")] grace_sec: u32 },

// 3) 新增：对手在宽限期内回来了
//    对应 TS: ServerPeerOnlineMsg { t:'peer-online' }
PeerOnline,

// 4) 新增：resume 校验通过，座位已恢复
//    对应 TS: ServerResumedMsg { t:'resumed'; room, peerId, token }
Resumed {
    room: String,
    #[serde(rename = "peerId")] peer_id: String,
    token: String,
},
```

对既有变体的**纯增量**扩展（旧客户端忽略未知字段，不崩）：

```rust
Created { room: String, peer_id: String, token: Option<String> },  // token 可选
Joined  { room: String, peer_id: String, token: Option<String> },  // token 可选
Error   { message: String, code: Option<String> },                 // code 可选
```

`Error.code` 取值（逐字，对应 TS `ServerErrorCode`）：
`ROOM_FORMAT` / `ROOM_EXISTS` / `ROOM_NOT_FOUND` / `ROOM_FULL` / `UNKNOWN_TYPE` / `RESUME_REJECTED` / `RESUME_TOKEN_INVALID`。

> ⚠️ 注意：`PeerLeft` **必须保留**。回签 Q-A 明确「宽限期超时后补发 `peer-left` 作为旧客户端兜底」。

---

## 2. `src/protocol/mod.rs` —— `classify` 需识别两个新上行类型

```rust
"ping"   => Classification::Ping { ts: opt_f64(value.get("ts")) },
"resume" => Classification::Resume {
    room:   coerce_str(value.get("room")),
    peer_id: coerce_str(value.get("peerId")),
    token:  coerce_str(value.get("token")),
},
```

要点：

- `ping` **不得**改任何连接/房间状态，收到即回 `Pong`（对齐 TS「不改任何状态」）。
- `resume` 是**非幂等**的：成功后必须轮换 token，旧 token 立即失效（防重放）。
- `resume` 校验失败时回 `Error { code: RESUME_TOKEN_INVALID | RESUME_REJECTED }`，
  文案逐字复用 v1 措辞（`ERR_RESUME_REJECTED` / `ERR_RESUME_TOKEN_INVALID` 需新增到 `messages.rs`）。
- `classify` 的静默忽略规则**不得改动**（非 JSON / 非对象 / 缺 `t` / `signal.data` 为 falsy）。

---

## 3. 新增 `src/transport/seat.rs`（座位与宽限期）

对应 Node 侧 `apps/server/src/grace.ts` + `apps/server/src/token.ts`，语义逐条对齐：

| 能力 | 语义 |
|---|---|
| `issue(peerId, room, name, role)` | 建连/进房时发放座位 + 32 字节 base64url token |
| `mark_offline(peer_id, now)` | 连接断开时打时间戳；**幂等**（重复调用返回 `None`） |
| `verify(peer_id, room, token, now)` | `unknown` → `invalid`(room) → `invalid`(token) → `expired` → `ok`（顺序不可变，避免侧信道） |
| `rotate(peer_id, now)` | resume 成功后轮换 token，并**清空**该座位的宽限标记 |
| `sweep(now)` | 每 5s 扫一次，返回过期座位；调用方对每个过期座位执行 `leave` → 广播 `peer-left` |
| `grace` | 60s（配置项 `session.grace_secs`，禁止硬编码） |

并发要求（Rust 侧特有）：

- 座位表必须与房间表在同一 actor / 同一把锁的作用域内更新，避免「房间已销毁但座位还在」。
- `sweep` 与 `resume` 必须原子互斥：`sweep` 已判定过期的座位，`resume` 必须失败（`expired`）。

---

## 4. 连接生命周期改造（`src/transport/connection.rs` / `router.rs`）

| 时机 | v1 行为 | v1.1 要求 |
|---|---|---|
| 连接断开 | 立即 `leave` → 广播 `peer-left` | **保留座位**，广播 `peer-offline{graceSec:60}`；`peer-left` 只在 `sweep` 过期时补发 |
| `resume` 成功 | — | 重新绑定 `peerId → 新连接`，回 `resumed{room,peerId,token}`，并向对端广播 `peer-online` |
| `resume` 失败 | — | 回 `error{code}`，不销毁座位（座位仍等宽限期自然过期） |
| 旧连接的迟到 `close` | — | 必须忽略（Node 侧用 `seatOwner: peerId → connId` 实现，Rust 侧建议同款） |
| `signal` 转发 | 对端不在线 → `error: 房间 X 不存在` | 对端**在宽限期内**：静默丢弃并计数（不要回 error，否则客户端会误判房间失效） |

---

## 5. 与 Node 端的等价性验收（下一期必须补齐的测试）

1. `classify` 对 `ping` / `resume` 的分类用例（含 `ts` 缺失、`token` 为空）。
2. `Pong` / `PeerOffline` / `PeerOnline` / `Resumed` 的**逐字序列化**断言（照抄现有 `created_serialization_is_exact` 风格）。
3. 座位状态机：`issue → mark_offline → verify(ok) → rotate → 旧 token invalid`。
4. 宽限期：`59999ms` 不过期、`60000ms` 过期并触发一次 `peer-left`。
5. 旧连接迟到 `close` 不得把已 resume 的座位重新置为离线。
6. 双端同时掉线：两端各自 resume 成功后，双方都能收到对端 `peer-online`。

---

## 6. 变更纪律

- 任何对 `types.ts` 的改动都必须**先**回签，再同步本文件与 Rust 侧；顺序不可颠倒。
- 本文件是「待办清单」，不是契约；契约冲突时以 `packages/shared/src/types.ts` 为准。
