// 黑灯工厂侧边栏「无感静默刷新」验收测试（NLSpec: sidebar-silent-refresh，需求①）。
// 组件 frontend/sidebar_view.js 是纯浏览器 ES module，本测试在 Node 中 stub 浏览器环境后加载，
// 用 Node 内置 test runner 断言模板渲染分支与数据加载方法语义，验证 NLSpec 验收标准：
//   1. 刷新期间（loading 中）NLSpec 列表保持旧数据可见，不显示「扫描中…」占位；
//   2. 刷新期间依赖图保持旧 SVG 可见，不显示「加载依赖图…」占位；
//   3. 刷新期间产物列表、同步状态、工作区状态保持旧值；
//   4. 新数据就绪后各区块原地替换为最新内容；
//   5. 首次加载（无数据）时仍显示 loading 占位；
//   6. 现有触发机制（60s 轻量轮询/可见性刷新/防重入/静默失败）零回归。
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- 浏览器环境 stub（组件顶层依赖 window/localStorage/document）----
globalThis.window = {
  location: { protocol: "http:" },
  confirm: () => true,
  __jarvisFetch: null,
  __jarvisOn: null,
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = {};
Object.defineProperty(globalThis.document, "visibilityState", {
  get: () => "visible",
  configurable: true,
});
globalThis.localStorage = {
  _store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this._store, key)
      ? this._store[key]
      : null;
  },
  setItem(key, value) {
    this._store[key] = String(value);
  },
  removeItem(key) {
    delete this._store[key];
  },
};

const { default: component } = await import(
  new URL("../frontend/sidebar_view.js", import.meta.url).href
);

// ---- 源码文本断言 ----
import { readFileSync } from "node:fs";
const src = readFileSync(
  new URL("../frontend/sidebar_view.js", import.meta.url),
  "utf-8",
);

// ---- 工具：stub window.__jarvisFetch 模拟后端调用 ----
// handler(fn, args) 返回 callFunction 的最终 payload（{success, result:{success,data}} 或 {success:false,error:{message}}）
function stubFetch(handler) {
  window.__jarvisFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body || "{}");
    return { json: async () => handler(body.function, body.arguments || {}) };
  };
}
function ok(data) {
  return { success: true, result: { success: true, data } };
}
function fail(msg) {
  return { success: false, error: { message: msg } };
}

// 构造最小 vm（含旧数据，模拟"已有数据时刷新"）
function makeVm() {
  return {
    projectDir: "/p",
    nodeId: "master",
    dirs: [],
    nlspecs: [{ name: "old.md", title: "旧 Spec", status: "active" }],
    nlspecLoading: false,
    nlspecError: "",
    syncStatus: { has_baseline: true, base_commit: "abc" },
    artifacts: [{ type: "file", name: "old.md", path: "old.md" }],
    artifactOutputDir: "/p/_reversa_sdd",
    depsGraph: { nodes: [{ path: "/p", label: "p" }], edges: [] },
    depsLoading: false,
    status: { installed: true, version: "1.0" },
    loading: false,
    error: "",
  };
}

// ---- 模板渲染分支断言 ----

test("验收1：NLSpec 列表「扫描中…」占位仅在无数据时显示（v-if 条件收紧）", () => {
  assert.match(
    src,
    /v-if="nlspecLoading\s*&&\s*!nlspecs\.length"/,
    "扫描中占位应仅在 nlspecLoading 且无列表数据时显示",
  );
  assert.doesNotMatch(
    src,
    /v-if="nlspecLoading"\s*style="color:#888;font-size:11px;">扫描中/,
    "不应再无条件以 nlspecLoading 隐藏整个列表",
  );
});

test("验收2：依赖图「加载依赖图…」占位改为 v-else-if（有图时始终渲染 SVG）", () => {
  assert.match(src, /v-else-if="depsLoading"/, "依赖图加载占位应为 v-else-if 分支");
  assert.doesNotMatch(
    src,
    /depsLoading\s*\?\s*'加载依赖图…'/,
    "不应再用三元表达式内联「加载依赖图…」占位",
  );
});

test("验收3：工作区状态「加载中…」占位仅在无状态时显示", () => {
  assert.match(
    src,
    /v-if="loading\s*&&\s*!status"/,
    "加载中占位应仅在 loading 且无状态数据时显示",
  );
});

// ---- 数据加载方法语义断言（刷新期间保留旧数据）----

test("验收4：scanNlspecs 失败时保留旧 nlspecs（不清空，刷新期间旧列表可见）", async () => {
  stubFetch(() => fail("boom"));
  const vm = makeVm();
  await component.methods.scanNlspecs.call(vm);
  assert.equal(vm.nlspecs.length, 1, "失败后应保留旧列表");
  assert.equal(vm.nlspecs[0].name, "old.md", "旧列表内容不应被清空");
  assert.equal(vm.nlspecLoading, false, "finally 应复位 nlspecLoading");
});

test("验收5：loadSyncStatus 失败时保留旧 syncStatus（不清空）", async () => {
  stubFetch(() => fail("boom"));
  const vm = makeVm();
  await component.methods.loadSyncStatus.call(vm);
  assert.ok(vm.syncStatus, "失败后应保留旧 syncStatus");
  assert.equal(vm.syncStatus.base_commit, "abc", "旧 syncStatus 内容不应被清空");
});

test("验收6：loadArtifacts 失败时保留旧 artifacts（不整体替换）", async () => {
  stubFetch(() => fail("boom"));
  const vm = makeVm();
  await assert.rejects(() => component.methods.loadArtifacts.call(vm));
  assert.equal(vm.artifacts.length, 1, "失败后应保留旧 artifacts");
  assert.equal(vm.artifacts[0].name, "old.md");
});

test("验收7：loadDepsGraph 失败时保留旧 depsGraph（不清空）", async () => {
  stubFetch(() => fail("boom"));
  const vm = makeVm();
  await component.methods.loadDepsGraph.call(vm);
  assert.ok(vm.depsGraph, "失败后应保留旧 depsGraph");
  assert.equal(vm.depsGraph.nodes.length, 1, "旧依赖图内容不应被清空");
});

// ---- 新数据就绪后原地替换 ----

test("验收8：scanNlspecs 成功后就地替换为最新列表", async () => {
  stubFetch((fn) => {
    if (fn === "list_nlspecs") {
      return ok({ specs: [{ name: "new.md" }] });
    }
    if (fn === "get_nlspec") {
      return ok({ content: "## Goal\n目标\n## Constraints\n约束\n## Interfaces\n接口\n## Non-goals\n非目标\n" });
    }
    return ok({});
  });
  const vm = makeVm();
  await component.methods.scanNlspecs.call(vm);
  assert.equal(vm.nlspecs.length, 1, "成功后应替换为最新列表");
  assert.equal(vm.nlspecs[0].name, "new.md", "应整体替换为新数据");
});

test("验收9：loadSyncStatus 成功后就地替换为最新 syncStatus", async () => {
  stubFetch(() => ok({ has_baseline: true, base_commit: "new" }));
  const vm = makeVm();
  await component.methods.loadSyncStatus.call(vm);
  assert.equal(vm.syncStatus.base_commit, "new", "成功后应替换为最新 syncStatus");
});

test("验收10：loadArtifacts 成功后就地替换为最新 artifacts", async () => {
  stubFetch(() => ok({ files: [{ type: "file", name: "new.md", path: "new.md" }], output_dir: "/p/_reversa_sdd" }));
  const vm = makeVm();
  await component.methods.loadArtifacts.call(vm);
  assert.equal(vm.artifacts.length, 1, "成功后应替换为最新 artifacts");
  assert.equal(vm.artifacts[0].name, "new.md");
});

test("验收11：loadDepsGraph 成功后就地替换为最新 depsGraph", async () => {
  stubFetch(() => ok({ dependencies: [{ path: "/upstream" }] }));
  const vm = makeVm();
  await component.methods.loadDepsGraph.call(vm);
  assert.ok(vm.depsGraph, "成功后应替换为最新 depsGraph");
  assert.equal(vm.depsGraph.nodes.length, 2, "应包含项目目录与上游依赖两个节点");
});

// ---- 首次加载（无数据）仍显示 loading 占位 ----

test("验收12：无数据时模板仍保留 loading 占位（首次加载可见）", () => {
  // 占位文本仍存在（v-if 条件收紧而非删除）
  assert.match(src, />扫描中…</, "「扫描中…」占位文本应保留");
  assert.match(src, />加载依赖图…</, "「加载依赖图…」占位文本应保留");
  assert.match(src, />加载中…</, "「加载中…」占位文本应保留");
});

// ---- 现有触发机制零回归 ----

test("验收13：现有触发机制零回归——lightPoll 仍存在且不调用重接口", () => {
  assert.equal(typeof component.methods.lightPoll, "function", "lightPoll 应保留");
  const pollSrc = component.methods.lightPoll.toString();
  assert.ok(!/loadStatus/.test(pollSrc), "lightPoll 不得调用 loadStatus");
  assert.ok(!/loadProjectCheck/.test(pollSrc), "lightPoll 不得调用 loadProjectCheck");
  assert.ok(!/loadDepsGraph/.test(pollSrc), "lightPoll 不得调用 loadDepsGraph");
  assert.ok(!/ensureBaseline/.test(pollSrc), "lightPoll 不得调用 ensureBaseline");
});

test("验收14：现有触发机制零回归——scanNlspecs 防重入保护保留", () => {
  const scanSrc = component.methods.scanNlspecs.toString();
  assert.match(scanSrc, /!this\.projectDir\s*\|\|\s*this\.nlspecLoading/, "scanNlspecs 应保留 !projectDir || nlspecLoading 防重入保护");
});

test("验收15：现有触发机制零回归——refresh 全量链路保留（含 scanNlspecs 追加）", () => {
  const refreshSrc = component.methods.refresh.toString();
  assert.match(refreshSrc, /loadProjectCheck/, "refresh 应保留 loadProjectCheck");
  assert.match(refreshSrc, /loadStatus/, "refresh 应保留 loadStatus");
  assert.match(refreshSrc, /loadArtifacts/, "refresh 应保留 loadArtifacts");
  assert.match(refreshSrc, /loadSyncStatus/, "refresh 应保留 loadSyncStatus");
  assert.match(refreshSrc, /loadDepsGraph/, "refresh 应保留 loadDepsGraph");
  assert.match(refreshSrc, /scanNlspecs/, "refresh 应保留 scanNlspecs 追加调用");
});
