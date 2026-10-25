// 黑灯工厂侧边栏「右键菜单刷新」验收测试（NLSpec: refresh-context-menu）。
// 组件 frontend/sidebar_view.js 是纯浏览器 ES module，本测试在 Node 中 stub 浏览器环境后加载，
// 用 Node 内置 test runner 断言 template 结构与方法行为，验证 NLSpec 验收标准：
//   1. 侧边栏空白处右键弹出自定义菜单，菜单含「刷新」项；
//   2. 点击「刷新」项触发全量刷新（复用 refresh()）；
//   3. 顶部「刷新」按钮保留（全局唯一 button 元素，现有测试不破坏）；
//   4. 空白处右键阻止浏览器默认菜单（preventDefault）；
//   5. 刷新中（loading）菜单项置灰禁用；
//   6. 点击菜单外任意位置或按 Esc 关闭菜单。
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- 浏览器环境 stub（组件顶层依赖 window/localStorage）----
globalThis.window = {
  location: { protocol: "http:" },
  confirm: () => true,
  __jarvisFetch: null,
  innerWidth: 800,
  innerHeight: 600,
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

// 根容器：template 第一个 div（侧边栏根元素）
const rootOpen = tpl.indexOf("<div");
const rootClose = tpl.indexOf(">", rootOpen);
const rootTag = tpl.slice(rootOpen, rootClose + 1);

// 提取「刷新」菜单项块（非 button 元素，含「刷新」文案）
function refreshMenuItems() {
  const items = [];
  // 找所有含「刷新」的 div 块（排除 button）
  const re = /<div\b[^>]*>[\s\S]*?<\/div>/g;
  let m;
  while ((m = re.exec(tpl)) !== null) {
    const block = m[0];
    if (block.includes("刷新") && !block.includes("<button")) {
      items.push(block);
    }
  }
  return items;
}

test("验收1：data 含 contextMenu 状态（visible/x/y）", () => {
  const data = component.data();
  assert.ok(data.contextMenu, "data 应含 contextMenu");
  assert.equal(data.contextMenu.visible, false, "初始 visible 应为 false");
  assert.equal(typeof data.contextMenu.x, "number", "x 应为数字");
  assert.equal(typeof data.contextMenu.y, "number", "y 应为数字");
});

test("验收2：根容器绑定 @contextmenu=openContextMenu（空白处右键）", () => {
  assert.match(rootTag, /@contextmenu="openContextMenu"/, "根容器应绑定 contextmenu → openContextMenu");
});

test("验收3：根容器绑定 @click=closeContextMenu（点击外部关闭）", () => {
  assert.match(rootTag, /@click="closeContextMenu"/, "根容器应绑定 click → closeContextMenu");
});

test("验收4：根容器绑定 @keydown.esc=closeContextMenu（Esc 关闭）", () => {
  assert.match(rootTag, /@keydown\.esc="closeContextMenu"/, "根容器应绑定 keydown.esc → closeContextMenu");
});

test("验收5：存在 v-if=contextMenu.visible 的菜单元素且含「刷新」项", () => {
  assert.match(tpl, /v-if="contextMenu\.visible"/, "菜单元素应 v-if=contextMenu.visible");
  const items = refreshMenuItems();
  assert.ok(items.length >= 1, "应存在含「刷新」的非 button 菜单项");
  assert.ok(
    items.some((b) => b.includes("刷新")),
    "菜单项应含「刷新」文案",
  );
});

test("约束：菜单项不得用 <button> 元素（仅顶部唯一刷新按钮可用 button）", () => {
  // 含「刷新」的 button 应恰好 1 个（顶部全局刷新按钮），右键菜单项不得用 button
  const re = /<button\b[^>]*>[\s\S]*?<\/button>/g;
  const refreshButtons = [];
  let m;
  while ((m = re.exec(tpl)) !== null) {
    const block = m[0];
    if (block.includes("刷新") || block.includes("加载中")) {
      refreshButtons.push(block);
    }
  }
  assert.equal(refreshButtons.length, 1, `含「刷新」的 button 应恰好 1 个（顶部按钮），实际 ${refreshButtons.length} 个`);
});

test("验收6：菜单项刷新中（loading）置灰禁用", () => {
  const items = refreshMenuItems();
  assert.ok(
    items.some((b) => /loading/.test(b) && /disabled/.test(b)),
    "菜单项应绑定 loading 置灰禁用（:class 或 :disabled）",
  );
});

test("验收7：openContextMenu 阻止默认菜单并基于坐标定位", () => {
  assert.equal(typeof component.methods.openContextMenu, "function", "应存在 openContextMenu 方法");
  const src = component.methods.openContextMenu.toString();
  assert.match(src, /preventDefault/, "openContextMenu 应调用 e.preventDefault()");
  assert.match(src, /contextMenu\.x/, "应设置 contextMenu.x");
  assert.match(src, /contextMenu\.y/, "应设置 contextMenu.y");
  assert.match(src, /contextMenu\.visible\s*=\s*true/, "应置 visible = true");
});

test("验收8：openContextMenu 考虑视口边界避免菜单溢出", () => {
  const src = component.methods.openContextMenu.toString();
  assert.match(src, /innerWidth|clientWidth|offsetWidth/, "应参考视口宽度避免水平溢出");
  assert.match(src, /innerHeight|clientHeight|offsetHeight/, "应参考视口高度避免垂直溢出");
});

test("验收9：closeContextMenu 关闭菜单（visible=false）", () => {
  assert.equal(typeof component.methods.closeContextMenu, "function", "应存在 closeContextMenu 方法");
  const fakeThis = { contextMenu: { visible: true, x: 10, y: 20 } };
  component.methods.closeContextMenu.call(fakeThis);
  assert.equal(fakeThis.contextMenu.visible, false, "closeContextMenu 应置 visible=false");
});

test("验收10：refreshFromMenu 调用 refresh() 后关闭菜单", () => {
  assert.equal(typeof component.methods.refreshFromMenu, "function", "应存在 refreshFromMenu 方法");
  let refreshed = false;
  let closed = false;
  const fakeThis = {
    loading: false,
    contextMenu: { visible: true },
    refresh: async () => {
      refreshed = true;
    },
    closeContextMenu: () => {
      closed = true;
    },
  };
  component.methods.refreshFromMenu.call(fakeThis);
  assert.equal(refreshed, true, "refreshFromMenu 应调用 this.refresh()");
  assert.equal(closed, true, "refreshFromMenu 应调用 this.closeContextMenu()");
});

test("验收11：刷新中（loading）refreshFromMenu 不触发刷新", () => {
  let refreshed = false;
  const fakeThis = {
    loading: true,
    contextMenu: { visible: true },
    refresh: async () => {
      refreshed = true;
    },
    closeContextMenu: () => {},
  };
  component.methods.refreshFromMenu.call(fakeThis);
  assert.equal(refreshed, false, "loading 时 refreshFromMenu 不应触发刷新");
});
