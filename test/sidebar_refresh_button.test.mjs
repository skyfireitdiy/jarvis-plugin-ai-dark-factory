// 黑灯工厂侧边栏「统一刷新按钮」验收测试（NLSpec: unify-refresh-button）。
// 组件 frontend/sidebar_view.js 是纯浏览器 ES module，本测试在 Node 中 stub 浏览器环境后加载，
// 用 Node 内置 test runner 断言 template 结构，验证 NLSpec 验收标准：
//   1. 「刷新」按钮全局仅剩 1 个；
//   2. 该按钮位于头部下方、使用说明上方；
//   3. 点击后触发全量刷新（refresh）；
//   4. 「2.3 依赖图」区域不再出现刷新按钮；
//   5. 刷新期间按钮显示「加载中…」并禁用（:disabled="busy || loading"）。
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
const tpl = component.template;

// 提取 template 中所有「刷新」按钮（含 @click 为 refresh / loadDepsGraph 的 button）。
function refreshButtons() {
  // 简单扫描：找所有含「刷新」字样的 <button ...>...</button> 块
  const buttons = [];
  const re = /<button\b[^>]*>[\s\S]*?<\/button>/g;
  let m;
  while ((m = re.exec(tpl)) !== null) {
    const block = m[0];
    if (block.includes("刷新") || block.includes("加载中")) {
      buttons.push(block);
    }
  }
  return buttons;
}

test("验收1：侧边栏「刷新」按钮全局仅剩 1 个", () => {
  const buttons = refreshButtons();
  assert.equal(buttons.length, 1, `应恰好 1 个刷新按钮，实际 ${buttons.length} 个`);
});

test("验收2：唯一刷新按钮位于头部下方、使用说明上方", () => {
  const headerEnd = tpl.indexOf("</div>", tpl.indexOf("<!-- 头部 -->"));
  const guideStart = tpl.indexOf("<!-- 使用说明");
  const btnIdx = tpl.indexOf("@click=\"refresh\"");
  assert.ok(headerEnd !== -1 && guideStart !== -1 && btnIdx !== -1, "关键锚点缺失");
  assert.ok(
    btnIdx > headerEnd && btnIdx < guideStart,
    `刷新按钮位置异常：headerEnd=${headerEnd}, btnIdx=${btnIdx}, guideStart=${guideStart}`,
  );
});

test("验收3：唯一刷新按钮 @click 绑定 refresh（全量刷新）", () => {
  const buttons = refreshButtons();
  assert.match(buttons[0], /@click="refresh"/, "全局刷新按钮必须调用 refresh()");
});

test("验收4：「2.3 依赖图」区域不再出现刷新按钮", () => {
  const depsSectionStart = tpl.indexOf("2.3 依赖图");
  assert.ok(depsSectionStart !== -1, "找不到 2.3 依赖图区域");
  // 从依赖图标题往后扫描，不应再有刷新按钮
  const afterDeps = tpl.slice(depsSectionStart);
  const re = /<button\b[^>]*>[\s\S]*?<\/button>/g;
  let m;
  while ((m = re.exec(afterDeps)) !== null) {
    const block = m[0];
    assert.ok(
      !block.includes("刷新") && !block.includes("加载中"),
      `依赖图区域仍存在刷新按钮: ${block.slice(0, 80)}`,
    );
  }
});

test("验收5：刷新按钮刷新中显示「加载中…」并禁用（:disabled=\"busy || loading\"）", () => {
  const buttons = refreshButtons();
  assert.match(buttons[0], /:disabled="busy \|\| loading"/, "disabled 条件应为 busy || loading");
  assert.match(buttons[0], /\{\{ loading \? '加载中…' : '刷新' \}\}/, "文案应为 loading 时「加载中…」否则「刷新」");
});

test("约束：2.1 工作区状态区域不再有刷新按钮", () => {
  const wsStart = tpl.indexOf("2.1 工作区状态");
  const wsEnd = tpl.indexOf("2.2 上游依赖");
  assert.ok(wsStart !== -1 && wsEnd !== -1 && wsEnd > wsStart, "找不到 2.1 工作区状态区域");
  const wsSection = tpl.slice(wsStart, wsEnd);
  // 只检查 button 元素：2.1 区域不应再有「刷新」按钮（「加载中…」状态文本 span 属正常展示，不算按钮）
  const re = /<button\b[^>]*>[\s\S]*?<\/button>/g;
  let m;
  while ((m = re.exec(wsSection)) !== null) {
    const block = m[0];
    assert.ok(
      !block.includes("刷新") && !block.includes("加载中"),
      `2.1 工作区状态区域仍存在刷新按钮: ${block.slice(0, 80)}`,
    );
  }
});

test("约束：refresh() 方法保持不变（仍是全量刷新入口）", () => {
  const refreshSrc = component.methods.refresh.toString();
  assert.match(refreshSrc, /loadProjectCheck/);
  assert.match(refreshSrc, /loadStatus/);
  assert.match(refreshSrc, /loadArtifacts/);
  assert.match(refreshSrc, /loadSyncStatus/);
  assert.match(refreshSrc, /ensureBaseline/);
  assert.match(refreshSrc, /loadDepsGraph/);
});

test("约束：loadDepsGraph() 方法仍存在（由 refresh 内部调用）", () => {
  assert.equal(typeof component.methods.loadDepsGraph, "function");
});
