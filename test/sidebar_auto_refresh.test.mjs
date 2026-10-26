// 黑灯工厂侧边栏「两级自动刷新」验收测试（NLSpec: sidebar-auto-refresh）。
// 组件 frontend/sidebar_view.js 是纯浏览器 ES module，本测试在 Node 中 stub 浏览器环境后加载，
// 用 Node 内置 test runner 断言常量/方法/生命周期，验证 NLSpec 验收标准：
//   1. 可见性刷新：visibilitychange → visible 时触发一次全量 refresh()；
//   2. 低频轻量兜底：默认 60s，仅前台可见时执行，只更新 NLSpec 列表/产物列表/同步状态，
//      不重复拉取分析进度（不调用 loadStatus）；
//   3. 间隔可配置：localStorage key jarvis_df_light_poll_interval，30s~300s 生效，非法回退 60000；
//   4. 防重入：busy/loading 时不触发任何自动刷新；
//   5. 静默失败：自动刷新失败不写 this.error；
//   6. 生命周期清理：beforeUnmount 移除监听并 clearInterval。
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- 浏览器环境 stub（组件顶层依赖 window/localStorage/document）----
// visibilityState 用可变对象模拟，测试中可切换前台/后台。
const visibility = { state: "visible" };
globalThis.window = {
  location: { protocol: "http:" },
  confirm: () => true,
  __jarvisFetch: null,
  __jarvisOn: null,
  addEventListener: () => {},
  removeEventListener: () => {},
};
// Node 无全局 document，先创建 stub 再定义 visibilityState getter
globalThis.document = {};
Object.defineProperty(globalThis.document, "visibilityState", {
  get: () => visibility.state,
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

// ---- 常量断言（读取源码文本）----
import { readFileSync } from "node:fs";
const src = readFileSync(
  new URL("../frontend/sidebar_view.js", import.meta.url),
  "utf-8",
);

test("验收1：顶层常量定义（默认间隔 60000 / key / 范围 30000~300000）", () => {
  assert.match(src, /const\s+LIGHT_POLL_INTERVAL\s*=\s*60000/, "应定义 LIGHT_POLL_INTERVAL=60000");
  assert.match(src, /const\s+LIGHT_POLL_INTERVAL_KEY\s*=\s*"jarvis_df_light_poll_interval"/, "应定义 LIGHT_POLL_INTERVAL_KEY");
  assert.match(src, /const\s+LIGHT_POLL_MIN\s*=\s*30000/, "应定义 LIGHT_POLL_MIN=30000");
  assert.match(src, /const\s+LIGHT_POLL_MAX\s*=\s*300000/, "应定义 LIGHT_POLL_MAX=300000");
});

test("验收2：lightPollInterval() 无配置时返回默认 60000", () => {
  assert.equal(typeof component.methods.lightPollInterval, "function", "应存在 lightPollInterval 方法");
  localStorage._store = {};
  const val = component.methods.lightPollInterval.call({});
  assert.equal(val, 60000, "无配置时应返回默认 60000");
});

test("验收3：lightPollInterval() 合法配置（30s~300s）生效", () => {
  localStorage._store = { jarvis_df_light_poll_interval: "45000" };
  const val = component.methods.lightPollInterval.call({});
  assert.equal(val, 45000, "45000 在 [30000,300000] 内应生效");
  localStorage._store = { jarvis_df_light_poll_interval: "30000" };
  assert.equal(component.methods.lightPollInterval.call({}), 30000, "下界 30000 应生效");
  localStorage._store = { jarvis_df_light_poll_interval: "300000" };
  assert.equal(component.methods.lightPollInterval.call({}), 300000, "上界 300000 应生效");
});

test("验收4：lightPollInterval() 非法/越界配置回退默认 60000", () => {
  // 越界：低于 30s
  localStorage._store = { jarvis_df_light_poll_interval: "10000" };
  assert.equal(component.methods.lightPollInterval.call({}), 60000, "低于 30000 应回退 60000");
  // 越界：高于 300s
  localStorage._store = { jarvis_df_light_poll_interval: "600000" };
  assert.equal(component.methods.lightPollInterval.call({}), 60000, "高于 300000 应回退 60000");
  // 非数字
  localStorage._store = { jarvis_df_light_poll_interval: "abc" };
  assert.equal(component.methods.lightPollInterval.call({}), 60000, "非数字应回退 60000");
  // 空字符串
  localStorage._store = { jarvis_df_light_poll_interval: "" };
  assert.equal(component.methods.lightPollInterval.call({}), 60000, "空字符串应回退 60000");
});

test("验收5：lightPoll() 存在且为 async 方法", () => {
  assert.equal(typeof component.methods.lightPoll, "function", "应存在 lightPoll 方法");
  assert.match(component.methods.lightPoll.toString(), /async\s+lightPoll\(\)/, "lightPoll 应为 async 方法");
});

test("验收6：lightPoll() 前置条件——projectDir 缺失直接 return", async () => {
  let called = false;
  const fakeThis = {
    projectDir: "",
    busy: false,
    loading: false,
    scanNlspecs: async () => { called = true; },
    loadArtifacts: async () => {},
    loadSyncStatus: async () => {},
    _startLightPoll: () => {},
  };
  await component.methods.lightPoll.call(fakeThis);
  assert.equal(called, false, "projectDir 缺失时不应执行任何加载");
});

test("验收7：lightPoll() 前置条件——busy/loading 时直接 return", async () => {
  let called = false;
  const mk = (over) => ({
    projectDir: "/p",
    busy: false,
    loading: false,
    scanNlspecs: async () => { called = true; },
    loadArtifacts: async () => {},
    loadSyncStatus: async () => {},
    _startLightPoll: () => {},
    ...over,
  });
  called = false;
  await component.methods.lightPoll.call(mk({ busy: true }));
  assert.equal(called, false, "busy 时不应执行");
  called = false;
  await component.methods.lightPoll.call(mk({ loading: true }));
  assert.equal(called, false, "loading 时不应执行");
});

test("验收8：lightPoll() 前置条件——后台不可见时直接 return", async () => {
  let called = false;
  const fakeThis = {
    projectDir: "/p",
    busy: false,
    loading: false,
    scanNlspecs: async () => { called = true; },
    loadArtifacts: async () => {},
    loadSyncStatus: async () => {},
    _startLightPoll: () => {},
  };
  visibility.state = "hidden";
  await component.methods.lightPoll.call(fakeThis);
  assert.equal(called, false, "后台不可见时不应执行");
  visibility.state = "visible";
});

test("验收9：lightPoll() 依次 await scanNlspecs/loadArtifacts/loadSyncStatus", async () => {
  const order = [];
  const fakeThis = {
    projectDir: "/p",
    busy: false,
    loading: false,
    scanNlspecs: async () => { order.push("scanNlspecs"); },
    loadArtifacts: async () => { order.push("loadArtifacts"); },
    loadSyncStatus: async () => { order.push("loadSyncStatus"); },
    _startLightPoll: () => {},
  };
  visibility.state = "visible";
  await component.methods.lightPoll.call(fakeThis);
  assert.deepEqual(order, ["scanNlspecs", "loadArtifacts", "loadSyncStatus"], "应按序执行三项轻量刷新");
});

test("验收10：lightPoll() 不调用重接口（loadStatus/loadProjectCheck/loadDepsGraph/ensureBaseline）", () => {
  const src = component.methods.lightPoll.toString();
  assert.ok(!/loadStatus/.test(src), "lightPoll 不得调用 loadStatus（不重复拉取分析进度）");
  assert.ok(!/loadProjectCheck/.test(src), "lightPoll 不得调用 loadProjectCheck");
  assert.ok(!/loadDepsGraph/.test(src), "lightPoll 不得调用 loadDepsGraph");
  assert.ok(!/ensureBaseline/.test(src), "lightPoll 不得调用 ensureBaseline");
});

test("验收11：lightPoll() 失败静默——不写 this.error、不抛出", async () => {
  const fakeThis = {
    projectDir: "/p",
    busy: false,
    loading: false,
    error: "",
    scanNlspecs: async () => { throw new Error("boom"); },
    loadArtifacts: async () => {},
    loadSyncStatus: async () => {},
    _startLightPoll: () => {},
  };
  visibility.state = "visible";
  await component.methods.lightPoll.call(fakeThis); // 不应抛出
  assert.equal(fakeThis.error, "", "失败应静默，不写 this.error");
});

test("验收12：_onVisibilityChange() 可见且空闲时调用全量 refresh(true)（静默）", async () => {
  assert.equal(typeof component.methods._onVisibilityChange, "function", "应存在 _onVisibilityChange 方法");
  let refreshedWith = null;
  const fakeThis = {
    projectDir: "/p",
    busy: false,
    loading: false,
    refresh: async (silent) => { refreshedWith = silent; },
  };
  visibility.state = "visible";
  await component.methods._onVisibilityChange.call(fakeThis);
  assert.equal(refreshedWith, true, "前台可见且空闲时应调用 refresh(true)（静默，不写 this.error）");
});

test("验收12b：_onVisibilityChange() 调用 refresh(true)（静默）——源码断言", () => {
  // _onVisibilityChange 是事件处理器（不 await refresh），静默语义由 refresh(silent) 内部保证。
  // 此处断言其确实以 refresh(true) 调用，使可见性刷新失败时不写 this.error。
  const src = component.methods._onVisibilityChange.toString();
  assert.match(src, /refresh\s*\(\s*true\s*\)/, "_onVisibilityChange 应调用 refresh(true) 实现静默");
});

test("验收12c：refresh(silent=true) 失败静默——不写 this.error、不抛异常", async () => {
  const fakeThis = {
    projectDir: "/p",
    busy: false,
    loading: false,
    error: "",
    loadProjectCheck: async () => { throw new Error("boom"); },
    loadStatus: async () => {},
    loadArtifacts: async () => {},
    loadSyncStatus: async () => {},
    ensureBaseline: async () => {},
    loadDepsGraph: async () => {},
    scanNlspecs: async () => {},
    analysisDone: false,
  };
  await component.methods.refresh.call(fakeThis, true); // 不应抛出
  assert.equal(fakeThis.error, "", "silent=true 时失败应静默，不写 this.error");
  assert.equal(fakeThis.loading, false, "finally 应复位 loading");
});

test("验收12d：refresh(silent=false) 失败仍写 this.error（手动刷新行为不变）", async () => {
  const fakeThis = {
    projectDir: "/p",
    busy: false,
    loading: false,
    error: "",
    loadProjectCheck: async () => { throw new Error("boom"); },
    loadStatus: async () => {},
    loadArtifacts: async () => {},
    loadSyncStatus: async () => {},
    ensureBaseline: async () => {},
    loadDepsGraph: async () => {},
    scanNlspecs: async () => {},
    analysisDone: false,
  };
  await component.methods.refresh.call(fakeThis, false); // 不应抛出
  assert.equal(fakeThis.error, "boom", "silent=false 时失败应写 this.error（保持手动刷新行为）");
  assert.equal(fakeThis.loading, false, "finally 应复位 loading");
});

test("验收13：_onVisibilityChange() 后台不可见时不刷新", async () => {
  let refreshed = false;
  const fakeThis = {
    projectDir: "/p",
    busy: false,
    loading: false,
    refresh: async () => { refreshed = true; },
  };
  visibility.state = "hidden";
  await component.methods._onVisibilityChange.call(fakeThis);
  assert.equal(refreshed, false, "后台不可见时不应调用 refresh()");
  visibility.state = "visible";
});

test("验收14：_onVisibilityChange() busy/loading/无项目时不刷新", async () => {
  let count = 0;
  const mk = (over) => ({
    projectDir: "/p",
    busy: false,
    loading: false,
    refresh: async () => { count += 1; },
    ...over,
  });
  visibility.state = "visible";
  count = 0;
  await component.methods._onVisibilityChange.call(mk({ busy: true }));
  assert.equal(count, 0, "busy 时不应刷新");
  count = 0;
  await component.methods._onVisibilityChange.call(mk({ loading: true }));
  assert.equal(count, 0, "loading 时不应刷新");
  count = 0;
  await component.methods._onVisibilityChange.call(mk({ projectDir: "" }));
  assert.equal(count, 0, "无项目时不应刷新");
});

test("验收15：mounted 注册 visibilitychange 监听 + 启动轻量定时器（_startLightPoll 内部用 lightPollInterval() 读间隔）", () => {
  const src = component.mounted.toString();
  assert.match(src, /addEventListener\s*\(\s*"visibilitychange"\s*,\s*this\._onVisibilityChange/, "mounted 应注册 visibilitychange → _onVisibilityChange");
  assert.match(src, /_startLightPoll\s*\(\)/, "mounted 应调用 _startLightPoll() 启动轻量定时器");
  // _startLightPoll 内部：setInterval(() => this.lightPoll(), this.lightPollInterval())
  const startSrc = component.methods._startLightPoll.toString();
  assert.match(startSrc, /setInterval\s*\(\s*\(\)\s*=>\s*this\.lightPoll\(\),\s*this\.lightPollInterval\(\)/, "_startLightPoll 应 setInterval lightPoll 且间隔用 lightPollInterval() 读取");
  assert.match(startSrc, /_lightTimer\s*=/, "应把定时器句柄存入 this._lightTimer");
});

test("验收15b：间隔热更新——lightPoll() 每次执行后重建定时器（_startLightPoll 重新读取间隔）", () => {
  const pollSrc = component.methods.lightPoll.toString();
  assert.match(pollSrc, /finally\s*\{/, "lightPoll 应有 finally 块");
  assert.match(pollSrc, /_startLightPoll\s*\(\)/, "lightPoll 执行后应调用 _startLightPoll() 重建定时器");
  const startSrc = component.methods._startLightPoll.toString();
  assert.match(startSrc, /lightPollInterval\s*\(\)/, "_startLightPoll 每次调用都应重新读取 lightPollInterval()");
  assert.match(startSrc, /clearInterval\s*\(\s*this\._lightTimer\s*\)/, "_startLightPoll 重建前应 clearInterval 旧定时器");
});

test("验收16：beforeUnmount 移除监听并 clearInterval", () => {
  const src = component.beforeUnmount.toString();
  assert.match(src, /removeEventListener\s*\(\s*"visibilitychange"\s*,\s*this\._onVisibilityChange/, "beforeUnmount 应移除 visibilitychange 监听");
  assert.match(src, /clearInterval\s*\(\s*this\._lightTimer\s*\)/, "beforeUnmount 应 clearInterval(this._lightTimer)");
  assert.match(src, /if\s*\(\s*this\._lightTimer\s*\)/, "clearInterval 前应判空");
  assert.match(src, /_unmounted\s*=\s*true/, "beforeUnmount 应标记 _unmounted=true（防止异步 lightPoll 重建定时器泄漏）");
});

test("验收16b：卸载后 _startLightPoll 不再启动定时器（防泄漏）", () => {
  const startSrc = component.methods._startLightPoll.toString();
  assert.match(startSrc, /if\s*\(\s*this\._unmounted\)\s*return/, "_startLightPoll 应在 _unmounted 时直接 return");
  // 行为验证：_unmounted=true 时不调用 setInterval
  let setIntervalCalled = false;
  const fakeThis = {
    _unmounted: true,
    _lightTimer: null,
    lightPollInterval: () => 60000,
  };
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => { setIntervalCalled = true; return 1; };
  try {
    component.methods._startLightPoll.call(fakeThis);
  } finally {
    globalThis.setInterval = origSetInterval;
  }
  assert.equal(setIntervalCalled, false, "_unmounted=true 时不应启动定时器");
});

test("验收17：不改变现有刷新机制（顶部按钮/右键菜单/pollStatus 保留）", () => {
  // 顶部「刷新」按钮仍唯一（template 中 @click=refresh 的 button）
  const re = /<button\b[^>]*>[\s\S]*?<\/button>/g;
  const refreshButtons = [];
  let m;
  while ((m = re.exec(component.template)) !== null) {
    const block = m[0];
    if (block.includes("刷新") || block.includes("加载中")) {
      refreshButtons.push(block);
    }
  }
  assert.equal(refreshButtons.length, 1, "顶部刷新按钮应仍唯一");
  // pollStatus 与 POLL_INTERVAL 不变
  assert.match(src, /const\s+POLL_INTERVAL\s*=\s*4000/, "POLL_INTERVAL 应保持 4000");
  assert.equal(typeof component.methods.pollStatus, "function", "pollStatus 应保留");
  assert.equal(typeof component.methods.refreshFromMenu, "function", "refreshFromMenu 应保留");
  assert.equal(typeof component.methods.refresh, "function", "refresh 应保留");
});
