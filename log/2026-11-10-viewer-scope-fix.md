# 2026-11-10 观众档案主播范围修复（v0.11.1）

## 现象

打开单个观众档案时，「主播范围」下拉显示软件记录过的所有主播，而不是该观众实际出现过的主播。

## 根因

- 前端详情页并行请求 `/api/broadcasters`（全局主播列表）和 `/api/viewers/:id`，然后把**全局列表**
  交给 `scopeOptions` 生成选项。
- `resolveScope` 也只从全局列表判断 scope 是否有效，导致无效的 `?broadcaster=` 被接受。
- 后端 `buildViewerProfile` 在请求一个与该观众无关系的主播时，用 `getBroadcaster` 回退并返回
  `scope.kind='broadcaster'` + `noRelationship`，让无关主播看起来像一个有效范围。

## 修复

1. 新增 `src/web/js/pages/viewer-scope.js`：
   - `scopeOptions(payload,t,{profile,includeAll})`：详情模式只使用 `profile.broadcasters`。
   - `resolveDetailScope(profile,raw,{currentId})`：只接受真实关联；无效/已删除回退到当前或第一个；
     无关联返回 `null`。
   - 列表页仍保留「全部主播 / 未归属」。
2. `src/web/js/pages/viewers.js`：
   - 详情 `related = baseProfile.broadcasters`；
   - 详情不再渲染「全部主播」；单主播时为只读标签；无关联时显示 `viewers.scope.noRelated*` 空状态；
   - 记忆标签的主播上下文只使用有效 scope 或第一个关联主播，不再回退到全局 `currentId`。
3. `src/analytics/viewers/profile.mjs`：无关系时返回 `scope.kind='none'`，删除 `getBroadcaster` 回退。
4. `src/web/styles/pages.css`：`.scope-static` 只读标签。
5. 三语 `viewers.scope.noRelatedTitle` / `noRelatedBody`。

## 数据来源

`profile.broadcasters` 来自 `viewerBroadcasters()` 查询 `viewer_broadcasters` 表。该表由
`EventIngest` 对**所有**带 `viewer_id` 的事件调用 `recordViewerBroadcasterActivity()` 更新，
因此普通聊天、礼物、SC、大航海等可识别互动都会建立关系；没有只查聊天表。

## 测试

- `tests/unit/viewer-scope.test.mjs`：选项过滤、列表页全量选项、无效 scope 回退、
  单主播隐藏下拉/空状态静态检查。
- `tests/integration/viewer-broadcaster-scope.test.mjs`：单主播、双主播、三主播、无关联、
  跨平台同名、仅礼物互动、无关 broadcaster 返回 none；同时断言 `viewerBroadcasters` 本身。
- 全量 **495 passed / 0 failed**（约 66 秒）。

## 构建

- `node scripts/build-windows.mjs` 成功：
  - `dist/LiveMemory.exe` 91.1 MB（95,567,360 bytes）
  - 145 资源，资源哈希 `eebfef0bc14877462667`
  - SHA-256 `8cbd7209c23d0c6198c4996c5f23577c826ce248351c9fb14cbca6075e7c4b47`
  - Manifest `requireAdministrator`
- 本机策略仍阻止启动 EXE 做运行验收；未声称已完成真实浏览器验收。
