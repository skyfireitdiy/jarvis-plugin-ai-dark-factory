// 黑灯工厂侧边栏 NLSpec「在编辑器中打开」回归测试。
// 缺陷：openNlspecInEditor 曾把相对路径 .jarvis/.df/specs/<name> 传给宿主 __jarvisOpenFile，
// 宿主按相对路径解析：未打开 agent 时无 working_dir 可拼 → 报「无法解析为绝对路径」；
// 打开 agent 后则被拼到当前 agent 的 working_dir 下 → 路径错位。
// 修复：改为传绝对路径 <projectDir>/.jarvis/.df/specs/<name>，与 openArtifact 传绝对路径一致。
// 本测试在 Node 中 stub 浏览器环境后加载组件，断言 openNlspecInEditor 调用宿主通道时传绝对路径。
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

test("验收1：openNlspecInEditor 调用宿主打开通道时传绝对路径（projectDir 前缀）", async () => {
  const opened = [];
  // 组件方法通过 window.__jarvisOpenFile 取宿主通道，这里注入桩并记录入参
  window.__jarvisOpenFile = async (path, options) => {
    opened.push({ path, options });
    return { success: true };
  };
  const vm = {
    projectDir: "/home/user/proj",
    nodeId: "master",
    message: "",
    error: "",
  };
  await component.methods.openNlspecInEditor.call(vm, "foo.md");
  assert.equal(opened.length, 1, "应调用宿主打开通道一次");
  const { path, options } = opened[0];
  assert.ok(path.startsWith("/"), `路径应为绝对路径，实际: ${path}`);
  assert.equal(path, "/home/user/proj/.jarvis/.df/specs/foo.md");
  assert.equal(options.nodeId, "master");
  assert.equal(options.workingDir, "/home/user/proj");
  assert.equal(vm.error, "", "不应报错");
});

test("验收2：openNlspecInEditor 传绝对路径而非相对路径（回归：不得退回相对路径）", () => {
  const src = component.methods.openNlspecInEditor.toString();
  // 必须基于 projectDir 拼接绝对路径，不得把裸相对路径 .jarvis/.df/specs 直接传给宿主
  assert.match(src, /projectDir/, "应使用 projectDir 拼接绝对路径");
  assert.match(src, /\.jarvis\/\.df\/specs/, "应指向固定 spec 目录");
  // 相对路径字面量不得作为传给宿主的 path（宿主无法解析）
  assert.doesNotMatch(
    src,
    /openFile\(\s*["']\.jarvis\/\.df\/specs/,
    "不得把相对路径字面量直接传给宿主",
  );
});
