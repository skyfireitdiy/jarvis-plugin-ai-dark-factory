// 黑灯工厂侧边栏「简化按钮补标记步骤 + 澄清提示词收尾」验收测试。
// 需求（NLSpec: quick-mark-completed-and-clarify-hint）：
//   Part A：前端「简化」按钮（openNlspecPipeline quick 分支）任务文本末尾追加
//     「开发完成后调用 set_nlspec_status 标记 completed（by=agent）」指令，
//     与 config.yaml 的 dark-factory/quick 模板（config.yaml:132-133）对齐。
//   Part B：需求澄清 Agent（runClarifyAgent 新建/编辑两分支）落盘后只提示用户
//     用黑灯工厂执行，不再「引导进入 <dark-factory/run> 开始开发」式询问。
// 本测试在 Node 中 stub 浏览器环境后加载组件，断言两处任务文本内容。
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

// 构造一个最小 vm：openNlspecPipeline 用到 projectDir/nodeId/message/error/nlspecBusy/nlspecs/missingElements
function makeVm(projectDir = "/home/user/proj") {
  return {
    projectDir,
    nodeId: "master",
    message: "",
    error: "",
    nlspecBusy: false,
    nlspecs: [{ name: "foo.md", status: "active", elements: { Goal: true, Constraints: true, Interfaces: true, "Non-goals": true } }],
    missingElements: () => [],
  };
}

// 捕获 openNlspecPipeline 注入的任务文本：stub 宿主创建通道，记录 prefill.task
async function captureOpenNlspecTask(mode, name = "foo.md") {
  let captured = null;
  window.__jarvisOpenCreateAgentModal = async (prefill) => {
    captured = prefill;
    return { confirmed: true };
  };
  const vm = makeVm();
  await component.methods.openNlspecPipeline.call(vm, name, mode);
  delete window.__jarvisOpenCreateAgentModal;
  assert.ok(captured, "应调用宿主创建通道");
  return captured.task;
}

// 捕获 runClarifyAgent 注入的任务文本：stub 宿主创建通道，记录 prefill.task
async function captureClarifyTask(isEdit, name = "foo.md") {
  let captured = null;
  window.__jarvisOpenCreateAgentModal = async (prefill) => {
    captured = prefill;
    return { confirmed: true };
  };
  const vm = makeVm();
  await component.methods.runClarifyAgent.call(vm, name, isEdit);
  delete window.__jarvisOpenCreateAgentModal;
  assert.ok(captured, "应调用宿主创建通道");
  return captured.task;
}

// ---- Part A：简化按钮补标记步骤 ----

test("验收1：quick 分支任务文本包含 set_nlspec_status 标记 completed 指令（by=agent）", async () => {
  const task = await captureOpenNlspecTask("quick");
  assert.match(task, /set_nlspec_status/, "应包含 set_nlspec_status 工具调用");
  assert.match(task, /标记为 completed/, "应包含标记为 completed 语义");
  assert.match(task, /by=agent/, "应包含 by=agent 来源标记");
  assert.match(task, /\.jarvis\/\.df\/specs\/<功能名>\.md/, "应指向固定 spec 目录");
});

test("验收2：quick 分支任务文本中标记步骤位于流程不变量之后（末尾追加）", async () => {
  const task = await captureOpenNlspecTask("quick");
  const idxMark = task.indexOf("set_nlspec_status");
  const idxPin = task.indexOf("【流程不变量 - 必须始终牢记】");
  assert.ok(idxMark > idxPin, "标记步骤应追加在流程不变量之后");
});

test("验收3：full 分支任务文本不包含 set_nlspec_status 标记指令（run 分支不动）", async () => {
  const task = await captureOpenNlspecTask("full");
  assert.doesNotMatch(task, /set_nlspec_status/, "full 分支不应含标记指令");
});

// ---- Part B：澄清提示词收尾 ----

test("验收4：澄清新建分支不再「引导进入 <dark-factory/run> 开始开发」式询问", async () => {
  const task = await captureClarifyTask(false);
  assert.doesNotMatch(
    task,
    /引导进入 <dark-factory\/run> 开始开发/,
    "新建分支不应再引导进入 run 开始开发",
  );
  assert.doesNotMatch(
    task,
    /确认后再引导进入/,
    "新建分支不应再含「确认后再引导进入」询问措辞",
  );
});

test("验收5：澄清编辑分支不再「引导进入 <dark-factory/run> 开始开发」式询问", async () => {
  const task = await captureClarifyTask(true);
  assert.doesNotMatch(
    task,
    /引导进入 <dark-factory\/run> 开始开发/,
    "编辑分支不应再引导进入 run 开始开发",
  );
});

test("验收6：澄清新建分支包含「提示用户…黑灯工厂执行」类提示措辞", async () => {
  const task = await captureClarifyTask(false);
  assert.match(task, /提示用户/, "应包含「提示用户」措辞");
  assert.match(task, /黑灯工厂执行/, "应包含「黑灯工厂执行」提示");
});

test("验收7：澄清编辑分支包含「提示用户…黑灯工厂执行」类提示措辞", async () => {
  const task = await captureClarifyTask(true);
  assert.match(task, /提示用户/, "应包含「提示用户」措辞");
  assert.match(task, /黑灯工厂执行/, "应包含「黑灯工厂执行」提示");
});

test("验收8：澄清新建分支保留「四要素未齐前不要进入流水线」纪律", async () => {
  const task = await captureClarifyTask(false);
  assert.match(task, /四要素未齐前不要进入流水线/, "应保留四要素未齐不进入流水线的纪律");
});
