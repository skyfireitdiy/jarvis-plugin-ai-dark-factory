// 黑灯工厂侧边栏「刷新时自动重扫 NLSpec」验收测试（NLSpec: refresh-nlspecs）。
// 组件 frontend/sidebar_view.js 是纯浏览器 ES module，本测试在 Node 中 stub 浏览器环境后加载，
// 用 Node 内置 test runner 断言 refresh() 方法源码，验证 NLSpec 验收标准：
//   1. refresh() 全量刷新链路中追加 scanNlspecs() 调用（方案 A：await，在 loadDepsGraph 之后）；
//   2. scanNlspecs() 签名与内部实现保持不变（仅作为 refresh 链路新增被调用方）；
//   3. refresh() 原有 5 项刷新（工作区状态、产物、同步状态、基线、依赖图）行为不变；
//   4. scanNlspecs() 的 nlspecLoading 防重入保护保留。
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- 浏览器环境 stub（组件顶层依赖 window/localStorage）----
globalThis.window = {
  location: { protocol: "http:" },
  confirm: () => true,
  __jarvisFetch: null,
};
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: component } = await import(
  new URL("../frontend/sidebar_view.js", import.meta.url).href
);

test("验收1：refresh() 全量刷新链路中追加 scanNlspecs() 调用", () => {
  const src = component.methods.refresh.toString();
  assert.match(src, /scanNlspecs/, "refresh() 应调用 scanNlspecs()");
  // 方案 A：await this.scanNlspecs()（保证刷新完成时列表已更新）
  assert.match(src, /await\s+this\.scanNlspecs\(\)/, "应使用 await this.scanNlspecs()");
});

test("验收2：scanNlspecs() 在 loadDepsGraph() 之后被调用（不早于其它刷新项）", () => {
  const src = component.methods.refresh.toString();
  const depsIdx = src.indexOf("loadDepsGraph");
  const scanIdx = src.indexOf("scanNlspecs");
  assert.ok(depsIdx !== -1 && scanIdx !== -1, "refresh() 应同时含 loadDepsGraph 与 scanNlspecs");
  assert.ok(
    scanIdx > depsIdx,
    "scanNlspecs() 应在 loadDepsGraph() 之后调用（追加到全量刷新链路末尾）",
  );
});

test("验收3：refresh() 原有 5 项刷新行为不变", () => {
  const src = component.methods.refresh.toString();
  assert.match(src, /loadProjectCheck/);
  assert.match(src, /loadStatus/);
  assert.match(src, /loadArtifacts/);
  assert.match(src, /loadSyncStatus/);
  assert.match(src, /ensureBaseline/);
  assert.match(src, /loadDepsGraph/);
});

test("验收4：scanNlspecs() 签名与防重入保护保持不变", () => {
  assert.equal(typeof component.methods.scanNlspecs, "function", "scanNlspecs 应存在");
  const src = component.methods.scanNlspecs.toString();
  // 签名不变：无参数
  assert.match(src, /async\s+scanNlspecs\(\)/, "scanNlspecs 应为无参 async 方法");
  // 防重入保护保留：projectDir 缺失或 nlspecLoading 时直接 return
  assert.match(src, /if\s*\(!this\.projectDir\s*\|\|\s*this\.nlspecLoading\)\s*return/, "应保留 nlspecLoading 防重入保护");
  // 内部仍调用 list_nlspecs（扫描逻辑不变）
  assert.match(src, /list_nlspecs/, "scanNlspecs 内部仍调用 list_nlspecs");
});

test("验收5：scanNlspecs() 内部实现不新增二次排序（直接消费返回顺序）", () => {
  const src = component.methods.scanNlspecs.toString();
  // 不应出现 sort 调用（排序在后端 list_nlspecs 完成）
  assert.ok(!/\.sort\(/.test(src), "scanNlspecs 不应做二次排序");
});
