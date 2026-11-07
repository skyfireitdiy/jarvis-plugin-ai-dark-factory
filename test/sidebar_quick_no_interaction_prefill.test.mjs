// 黑灯工厂侧边栏「简化按钮默认勾选无交互模式」验收测试（NLSpec: sidebar-silent-refresh，需求②）。
// 组件 frontend/sidebar_view.js 是纯浏览器 ES module，本测试在 Node 中 stub 浏览器环境后加载，
// 用 Node 内置 test runner 断言 openNlspecPipeline 等创建入口的 prefill 契约：
//   1. openNlspecPipeline(name, "quick") 的 prefill 含 noInteractionMode: true；
//   2. openNlspecPipeline(name, "full") 的 prefill 不含 noInteractionMode（或为 false）；
//   3. runClarifyAgent（新建/编辑）与 handleNewAgent（逆向）的 prefill 不含 noInteractionMode；
//   4. quick 分支 task 非空（满足宿主无交互模式任务描述必填约束）。
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

// 构造最小 vm：openNlspecPipeline 用到 projectDir/nodeId/message/error/nlspecBusy/nlspecs/missingElements
function makeVm(projectDir = "/home/user/proj") {
  return {
    projectDir,
    nodeId: "master",
    message: "",
    error: "",
    nlspecBusy: false,
    nlspecs: [
      {
        name: "foo.md",
        status: "active",
        elements: { Goal: true, Constraints: true, Interfaces: true, "Non-goals": true },
      },
    ],
    missingElements: () => [],
  };
}

// 捕获 openNlspecPipeline 的 prefill：stub 宿主创建通道，记录 prefill
async function captureOpenNlspecPrefill(mode, name = "foo.md") {
  let captured = null;
  window.__jarvisOpenCreateAgentModal = async (prefill) => {
    captured = prefill;
    return { confirmed: true };
  };
  const vm = makeVm();
  await component.methods.openNlspecPipeline.call(vm, name, mode);
  delete window.__jarvisOpenCreateAgentModal;
  assert.ok(captured, "应调用宿主创建通道");
  return captured;
}

// 捕获 runClarifyAgent 的 prefill
async function captureClarifyPrefill(isEdit, name = "foo.md") {
  let captured = null;
  window.__jarvisOpenCreateAgentModal = async (prefill) => {
    captured = prefill;
    return { confirmed: true };
  };
  const vm = makeVm();
  await component.methods.runClarifyAgent.call(vm, name, isEdit);
  delete window.__jarvisOpenCreateAgentModal;
  assert.ok(captured, "应调用宿主创建通道");
  return captured;
}

// 捕获 handleNewAgent 的 prefill（逆向分析）
async function captureNewAgentPrefill() {
  let captured = null;
  window.__jarvisOpenCreateAgentModal = async (prefill) => {
    captured = prefill;
    return { confirmed: true };
  };
  const vm = {
    projectDir: "/home/user/proj",
    nodeId: "master",
    busy: false,
    message: "",
    error: "",
    installed: true,
    projectReady: true,
    projectBlockReason: "",
    buildAnalysisPrompt: async () => "prompt",
  };
  await component.methods.handleNewAgent.call(vm);
  delete window.__jarvisOpenCreateAgentModal;
  assert.ok(captured, "应调用宿主创建通道");
  return captured;
}

test("验收1：openNlspecPipeline(name, 'quick') 的 prefill 含 noInteractionMode: true", async () => {
  const prefill = await captureOpenNlspecPrefill("quick");
  assert.equal(prefill.noInteractionMode, true, "quick 分支应默认勾选无交互模式");
});

test("验收2：openNlspecPipeline(name, 'full') 的 prefill 不含 noInteractionMode", async () => {
  const prefill = await captureOpenNlspecPrefill("full");
  assert.ok(
    !("noInteractionMode" in prefill),
    "full 分支不应含 noInteractionMode 字段",
  );
});

test("验收3：runClarifyAgent 新建分支的 prefill 不含 noInteractionMode", async () => {
  const prefill = await captureClarifyPrefill(false);
  assert.ok(
    !("noInteractionMode" in prefill),
    "澄清新建分支不应含 noInteractionMode 字段",
  );
});

test("验收4：runClarifyAgent 编辑分支的 prefill 不含 noInteractionMode", async () => {
  const prefill = await captureClarifyPrefill(true);
  assert.ok(
    !("noInteractionMode" in prefill),
    "澄清编辑分支不应含 noInteractionMode 字段",
  );
});

test("验收5：handleNewAgent（逆向分析）的 prefill 不含 noInteractionMode", async () => {
  const prefill = await captureNewAgentPrefill();
  assert.ok(
    !("noInteractionMode" in prefill),
    "逆向分析分支不应含 noInteractionMode 字段",
  );
});

test("验收6：quick 分支 task 非空（满足宿主无交互模式任务描述必填约束）", async () => {
  const prefill = await captureOpenNlspecPrefill("quick");
  assert.ok(prefill.task && prefill.task.trim().length > 0, "quick 分支 task 应非空");
  assert.ok(prefill.task.includes("<dark-factory/quick>"), "quick 分支 task 应含简化版指令标识");
});
