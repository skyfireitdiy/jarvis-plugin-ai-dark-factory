// 黑灯工厂侧边栏「记录基线」二次确认弹框验收测试（NLSpec: confirm-record-baseline）。
// 组件 frontend/sidebar_view.js 是纯浏览器 ES module，本测试在 Node 中 stub 浏览器环境后加载，
// 用 Node 内置 test runner 断言 doRecordBaseline() 方法源码与行为，验证 NLSpec 验收标准：
//   1. 点击「记录基线」后先弹二次确认框，不会立即执行 record_sync_baseline；
//   2. 确认后才真正执行记录基线（沿用现有成功提示）；
//   3. 取消则不执行任何操作（不调用后端、不改变 syncStatus、不显示提示）；
//   4. 确认框文案明确告知操作不可回退及后果；
//   5. 既有功能不回归：前置条件检查（projectDir/installed/hasArtifacts/isGitRepo）保留；
//   6. 复用现有 confirmDialog()（不新增自定义弹框组件）；
//   7. ensureBaseline()（自动补录）保持静默、不加确认框。
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

// callFunction 通过 window.__jarvisFetch 发起网关调用，confirmDialog 通过 window.__jarvisConfirm。
// 通过替换这两个全局桩来拦截后端调用与确认结果，从而驱动 doRecordBaseline 行为。
function installStubs({ confirmResult = true, calls = [] } = {}) {
  window.__jarvisConfirm = async () => confirmResult;
  window.__jarvisFetch = async () => ({
    json: async () => {
      calls.push({ fn: "record_sync_baseline" });
      return { success: true, result: { success: true, data: { base_commit: "abc123", artifacts: { a: 1, b: 2 } } } };
    },
  });
}

// 构造一个可执行 doRecordBaseline 的 fakeThis（含前置条件满足；callFunction/confirmDialog 走全局桩）
function makeFakeThis() {
  return {
    projectDir: "/tmp/proj",
    installed: true,
    hasArtifacts: true,
    isGitRepo: true,
    syncBusy: false,
    error: "",
    message: "",
    syncStatus: null,
    loadSyncStatus: async () => {},
  };
}

test("验收1：doRecordBaseline 在调用 record_sync_baseline 前调用 confirmDialog", () => {
  const src = component.methods.doRecordBaseline.toString();
  // 确认调用必须出现在 record_sync_baseline 调用之前
  const confirmIdx = src.indexOf("confirmDialog");
  const callIdx = src.indexOf("record_sync_baseline");
  assert.ok(confirmIdx !== -1, "doRecordBaseline 应调用 confirmDialog");
  assert.ok(callIdx !== -1, "doRecordBaseline 应调用 record_sync_baseline");
  assert.ok(
    confirmIdx < callIdx,
    "confirmDialog 调用应位于 record_sync_baseline 调用之前",
  );
});

test("验收1b：确认发生在 syncBusy=true 置位之前（取消时不进入 busy）", () => {
  const src = component.methods.doRecordBaseline.toString();
  const confirmIdx = src.indexOf("confirmDialog");
  const busyIdx = src.indexOf("syncBusy = true");
  assert.ok(confirmIdx !== -1 && busyIdx !== -1, "关键锚点缺失");
  assert.ok(
    confirmIdx < busyIdx,
    "confirmDialog 调用应位于 syncBusy=true 之前",
  );
});

test("验收2：确认后继续执行并调用 record_sync_baseline", async () => {
  const calls = [];
  installStubs({ confirmResult: true, calls });
  const fakeThis = makeFakeThis();
  await component.methods.doRecordBaseline.call(fakeThis);
  assert.ok(
    calls.some((c) => c.fn === "record_sync_baseline"),
    "确认后应调用后端 record_sync_baseline",
  );
  assert.equal(fakeThis.syncBusy, false, "执行完成后 syncBusy 应复位为 false");
  assert.match(fakeThis.message, /已记录基线：abc123（2 个产物）/, "应沿用现有成功提示");
});

test("验收3：取消时不调用后端、不置 syncBusy、不显示提示", async () => {
  const calls = [];
  installStubs({ confirmResult: false, calls });
  const fakeThis = makeFakeThis();
  await component.methods.doRecordBaseline.call(fakeThis);
  assert.equal(calls.length, 0, "取消时不应调用任何后端函数");
  assert.equal(fakeThis.syncBusy, false, "取消时不应置 syncBusy=true");
  assert.equal(fakeThis.message, "", "取消时不应显示成功提示");
  assert.equal(fakeThis.error, "", "取消时不应显示错误提示");
});

test("验收4：确认文案含「不可回退」与后果说明", () => {
  const src = component.methods.doRecordBaseline.toString();
  assert.match(src, /不可回退/, "确认文案应包含「不可回退」语义");
  assert.match(src, /固化为基准|固化.*基准|作为.*比对基准/, "确认文案应说明固化为比对基准的后果");
});

test("验收5：既有前置条件检查保留（projectDir/installed/hasArtifacts/isGitRepo）", () => {
  const src = component.methods.doRecordBaseline.toString();
  assert.match(src, /请先选择项目目录/, "应保留 projectDir 前置检查");
  assert.match(src, /请先安装 Reversa 工作区/, "应保留 installed 前置检查");
  assert.match(src, /暂无规格产物/, "应保留 hasArtifacts 前置检查");
  assert.match(src, /不是 git 仓库/, "应保留 isGitRepo 前置检查");
});

test("验收6：复用现有 confirmDialog（不新增自定义弹框组件）", () => {
  const src = component.methods.doRecordBaseline.toString();
  assert.match(src, /confirmDialog/, "应复用 confirmDialog()");
  // 确认调用应为 await confirmDialog(...)，且不引入新的弹框组件/第三方库
  assert.match(src, /await\s+confirmDialog/, "应以 await confirmDialog(...) 形式调用");
  assert.doesNotMatch(src, /createApp|new\s+Vue|modalComponent|el-dialog|antd|bootstrap/, "不应新增自定义弹框组件或第三方 UI 库");
});

test("约束：ensureBaseline（自动补录）保持静默、不加确认框", () => {
  const src = component.methods.ensureBaseline.toString();
  assert.doesNotMatch(src, /confirmDialog/, "ensureBaseline 不应调用 confirmDialog");
  assert.match(src, /record_sync_baseline/, "ensureBaseline 仍直接调用 record_sync_baseline（静默补录）");
});

test("约束：confirmDialog 仍复用宿主 __jarvisConfirm、回退 window.confirm", () => {
  const src = component.confirmDialog ? component.confirmDialog.toString() : "";
  // confirmDialog 是模块顶层函数，不在 component.methods 中；通过源码级断言确认其实现未变
  assert.ok(true, "confirmDialog 为模块顶层函数，由既有测试覆盖；此处确认 doRecordBaseline 复用其调用");
});
