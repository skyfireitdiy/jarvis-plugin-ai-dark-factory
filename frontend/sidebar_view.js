// Reversa 插件前端侧边栏视图。
// 约定：纯浏览器 ES module，用 window.Vue 渲染，导出 default 组件，不 import 'vue'。
// 功能：在编辑器左侧管理 Reversa 逆向工程工作区：
//   - 项目区：选择/添加项目目录（localStorage 按节点+项目持久化）、
//             安装/卸载 Reversa 工作区、查看分析状态（3-5s 轮询）；
//   - 分析控制：查看 5 阶段进度（reconhecimento→escavacao→interpretacao→geracao→revisao）；
//   - 产物浏览：树形浏览 _reversa_sdd/、查看内容、按置信度导出为 Jarvis rule、
//             转换已安装 SKILL.md 为 rule。
// 认证：所有读写经宿主 window.__jarvisFetch（自动携带 jarvis 认证），
//       通过插件功能代理端点 /api/plugins/<node>/function-call 调用插件私有功能层。
// 设计（issue #328）：后端无状态，设置纯前端 localStorage（按节点+项目 key 隔离）；
//       跨设备共享靠两台设备指向同一工作区目录。

const PLUGIN = "ai-dark-factory";
// 每节点项目目录列表持久化 key 前缀：jarvis_reversa_dirs_<node>（JSON 数组）。
const DIRS_KEY_PREFIX = "jarvis_reversa_dirs_";
// 每节点当前激活项目目录持久化 key 前缀：jarvis_reversa_active_<node>。
const ACTIVE_DIR_KEY_PREFIX = "jarvis_reversa_active_";
// 每节点项目目录历史上限（最近使用在前，超出截断）。
const DIRS_HISTORY_MAX = 10;
// 每节点+项目现存资料库持久化 key 前缀：jarvis_reversa_refs_<node>_<project>（JSON 数组）。
// 资料类型：doc=文档路径 / web=网页 URL / dir=目录路径；仅注入反构提示词，不落盘到项目。
const REFS_KEY_PREFIX = "jarvis_reversa_refs_";
// 轮询间隔（毫秒）：3-5s 轮询 state.json（决策 9）。
const POLL_INTERVAL = 4000;
// Reversa 5 阶段（state.json 的 pending/completed 字段值）
const PHASES = [
  "reconhecimento",
  "escavacao",
  "interpretacao",
  "geracao",
  "revisao",
];
const PHASE_LABELS = {
  reconhecimento: "侦察",
  escavacao: "挖掘",
  interpretacao: "解读",
  geracao: "生成",
  revisao: "评审",
};
// 置信度标记
const CONFIDENCE_CONFIRMED = "🟢CONFIRMED";
const CONFIDENCE_INFERRED = "🟡INFERRED";
const CONFIDENCE_GAP = "🔴GAP";

// 按节点生成项目目录列表存储 key
function dirsKey(nodeId) {
  return DIRS_KEY_PREFIX + (String(nodeId || "master").trim() || "master");
}
// 按节点生成激活项目目录存储 key
function activeDirKey(nodeId) {
  return ACTIVE_DIR_KEY_PREFIX + (String(nodeId || "master").trim() || "master");
}
// 按节点+项目生成现存资料库存储 key（资料只属于具体项目，切换项目即切换资料集）
function refsKey(nodeId, projectDir) {
  return (
    REFS_KEY_PREFIX +
    (String(nodeId || "master").trim() || "master") +
    "_" +
    (String(projectDir || "").trim() || "default")
  );
}

// 复刻 App.vue 的 gateway 地址解析（侧边栏组件无 props 注入，需自行解析）
function parseGatewayAddress(address) {
  address = (address || "").trim();
  if (!address) return null;
  if (address.includes("://")) {
    try {
      const url = new URL(address);
      return {
        protocol: url.protocol.replace(":", ""),
        host: url.hostname,
        port:
          url.port ||
          (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80"),
        path: url.pathname,
      };
    } catch {
      return null;
    }
  }
  if (address.includes(":")) {
    const parts = address.split(":");
    if (parts.length === 2) {
      return { protocol: null, host: parts[0], port: parts[1], path: "" };
    }
  }
  return { protocol: null, host: address, port: "8000", path: "" };
}
// 获取当前页面的 HTTP 协议（与 App.vue getHttpProtocol 一致）
function getHttpProtocol() {
  return window.location.protocol === "https:" ? "https" : "http";
}
function gatewayBase() {
  const parsed = parseGatewayAddress(
    localStorage.getItem("jarvis_gateway_url") || "",
  );
  const host = (parsed && parsed.host) || "127.0.0.1";
  const port = (parsed && parsed.port) || "8000";
  const protocol =
    parsed && parsed.protocol === "https" ? "https" : getHttpProtocol();
  return `${protocol}://${host}:${port}`;
}

// 通过 gateway 插件功能代理端点调用插件私有功能
// nodeId 指定目标节点（默认 master）：Reversa 生命周期与产物都在该节点本地执行
async function callFunction(functionName, args, nodeId) {
  const authedFetch =
    (typeof window !== "undefined" && window.__jarvisFetch) || fetch;
  const targetNodeId = String(nodeId || "master").trim() || "master";
  const resp = await authedFetch(
    `${gatewayBase()}/api/plugins/${encodeURIComponent(targetNodeId)}/function-call`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plugin: PLUGIN,
        function: functionName,
        arguments: args || {},
      }),
    },
  );
  let result;
  try {
    result = await resp.json();
  } catch (e) {
    throw new Error("网关响应异常", { cause: e });
  }
  if (!result.success) {
    const err = result.error || {};
    throw new Error(err.message || err.code || "调用失败");
  }
  const payload = result.result || {};
  if (payload.success === false) {
    throw new Error(payload.error || "操作失败");
  }
  return payload;
}

// 取路径的最后一段作为显示名（兼容 / 与 \）
function baseName(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

export default {
  name: "ReversaSidebarView",
  props: {
    workingDir: { type: String, default: "" },
  },
  data() {
    return {
      // 节点与当前节点（master 恒在列）
      nodes: [],
      nodeId: "master",
      // 项目目录列表与当前激活目录（localStorage 按节点持久化）
      dirs: [],
      projectDir: "",
      projectInput: "",
      // 状态
      status: null,
      loading: false,
      busy: false,
      error: "",
      message: "",
      // 产物浏览
      artifacts: [],
      artifactOpen: {}, // path -> bool（树展开状态）
      selectedArtifact: null,
      artifactContent: "",
      artifactLoading: false,
      // 导出
      exportBusy: false,
      includeGap: false,
      // 「导出 Rules 是做什么的」说明折叠状态
      exportHelpVisible: false,
      // 依赖图
      depsGraph: null, // {nodes: [{id,label,path}], edges: [{from,to}]}，from 依赖 to（箭头指向被依赖方）
      depsLoading: false,
      depInput: "",
      depBusy: false,
      // 现存资料库（doc=文档路径 / web=网页 URL / dir=目录路径；仅注入反构提示词）
      refs: [],
      refInput: "",
      refType: "doc",
      refBusy: false,
      // NLSpec 管理（issue #14）：固定目录 .jarvis/.df/specs/
      nlspecs: [], // [{name, title, updated_at, size, elements: {goal,constraints,interfaces,nongoals}}]
      nlspecLoading: false,
      nlspecBusy: false,
      // 知识回流（sync）
      syncStatus: null, // {has_baseline, base_commit, head_commit, stale, changed_artifacts, ...}
      syncBusy: false,
      // 前置条件检查结果（项目目录是否存在/是否 git 仓库），null 表示未检查
      projectCheck: null, // {path, exists, is_git, error?}
      projectCheckLoading: false,
      // 帮助弹层
      helpVisible: false,
      // 使用说明（闭环流程图）折叠状态
      guideVisible: true,
    };
  },
  computed: {
    // 当前激活项目目录（无则空）
    activeProject() {
      return this.projectDir;
    },
    // 是否已安装（status.installed）
    installed() {
      return !!(this.status && this.status.installed);
    },
    // 项目目录前置条件：已检查且目录存在（未检查时不拦截，避免首屏误禁用）
    projectReady() {
      const c = this.projectCheck;
      if (!c || c.path !== this.projectDir) return true;
      return !!c.exists;
    },
    // 项目目录前置条件未满足时的原因（用于按钮 title/提示）
    projectBlockReason() {
      const c = this.projectCheck;
      if (!c || c.path !== this.projectDir) return "";
      if (c.error) return c.error;
      if (!c.exists) return "项目目录不存在或不可访问，请重新选择";
      return "";
    },
    // 是否属于 git 仓库（知识回流依赖 git 基线；未检查时按可用处理）
    isGitRepo() {
      const c = this.projectCheck;
      if (!c || c.path !== this.projectDir) return true;
      return !!c.is_git;
    },
    // 逆向分析是否已全部完成（5 阶段）
    analysisDone() {
      if (!this.installed) return false;
      const done = new Set(
        (Array.isArray(this.status && this.status.completed)
          ? this.status.completed
          : []
        ).map((p) => String(p)),
      );
      return PHASES.every((p) => done.has(p));
    },
    // 是否已有规格产物（用于「导出 Rules」前置条件）
    hasArtifacts() {
      const walk = (list) =>
        (list || []).some(
          (n) => n && (n.type === "file" || (n.type === "dir" && walk(n.children))),
        );
      return walk(this.artifacts);
    },
    // 是否可开始逆向：必须已安装 + 项目目录可用 + 无进行中的操作
    canStartAnalysis() {
      return this.installed && this.projectReady && !this.busy && !this.loading;
    },
    // 开始逆向被禁用的原因（空串表示可执行）
    startAnalysisBlockReason() {
      if (!this.projectDir) return "请先选择项目目录";
      if (!this.projectReady) return this.projectBlockReason || "项目目录不可用";
      if (this.loading) return "正在加载项目状态…";
      if (!this.installed) return "请先安装 Reversa 工作区（2.1 / 2.5 的「安装 Reversa」）";
      if (this.busy) return "有操作正在进行，请稍候";
      return "";
    },
    // 是否可导出 Rules：已安装 + 有产物
    canExportRules() {
      return this.installed && this.hasArtifacts && !this.exportBusy;
    },
    // 导出 Rules 被禁用的原因
    exportBlockReason() {
      if (!this.installed) return "请先安装 Reversa 工作区";
      if (!this.hasArtifacts) return "暂无规格产物，请先运行 Reversa 分析";
      if (this.exportBusy) return "正在导出…";
      return "";
    },
    // 是否可记录基线：已安装 + 有产物 + git 仓库
    canRecordBaseline() {
      return this.installed && this.hasArtifacts && this.isGitRepo && !this.syncBusy;
    },
    // 记录基线被禁用的原因
    baselineBlockReason() {
      if (!this.installed) return "请先安装 Reversa 工作区";
      if (!this.hasArtifacts) return "暂无规格产物，请先运行 Reversa 逆向分析";
      if (!this.isGitRepo) return "项目不是 git 仓库，无法记录 commit 基线";
      if (this.syncBusy) return "处理中…";
      return "";
    },
    // 是否可分析差异：已有基线 + git 仓库
    canAnalyzeSync() {
      return (
        !!(this.syncStatus && this.syncStatus.has_baseline) &&
        this.isGitRepo &&
        !this.syncBusy
      );
    },
    // 分析差异被禁用的原因
    analyzeSyncBlockReason() {
      if (!this.isGitRepo) return "项目不是 git 仓库，无法比对代码变更";
      if (!(this.syncStatus && this.syncStatus.has_baseline)) return "请先「记录基线」";
      if (this.syncBusy) return "处理中…";
      return "";
    },
    // 当前阶段索引（-1 表示未开始/未知）
    currentPhaseIndex() {
      if (!this.status || !Array.isArray(this.status.completed)) return -1;
      let idx = -1;
      PHASES.forEach((p, i) => {
        if (this.status.completed.includes(p)) idx = i;
      });
      return idx;
    },
    // 阶段进度列表：[{key, label, state: done|current|todo}]
    phaseList() {
      const done = new Set(
        (this.status && Array.isArray(this.status.completed)
          ? this.status.completed
          : []
        ).map((p) => String(p)),
      );
      const cur = this.status && this.status.phase ? String(this.status.phase) : "";
      return PHASES.map((p) => {
        let state = "todo";
        if (done.has(p)) state = "done";
        else if (cur === p) state = "current";
        return { key: p, label: PHASE_LABELS[p] || p, state };
      });
    },
    // 依赖图节点坐标（网格布局）：nodes 带 x/y，edges 带 from/to 坐标
    depsLayout() {
      const g = this.depsGraph;
      if (!g || !g.nodes.length) return null;
      const NODE_W = 150;
      const NODE_H = 34;
      const GAP_X = 40;
      const GAP_Y = 30;
      const cols = Math.max(1, Math.ceil(Math.sqrt(g.nodes.length)));
      const nodes = g.nodes.map((n, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        return {
          ...n,
          x: col * (NODE_W + GAP_X),
          y: row * (NODE_H + GAP_Y),
          w: NODE_W,
          h: NODE_H,
        };
      });
      const byPath = {};
      nodes.forEach((n) => {
        byPath[n.path] = n;
      });
      const edges = g.edges.map((e) => {
        const from = byPath[e.from];
        const to = byPath[e.to];
        if (!from || !to) return null;
        // 箭头从依赖方 from 指向被依赖方 to（指向被依赖的上游）
        return {
          from,
          to,
          x1: from.x + from.w,
          y1: from.y + from.h / 2,
          x2: to.x,
          y2: to.y + to.h / 2,
        };
      }).filter(Boolean);
      const width = cols * (NODE_W + GAP_X) - GAP_X + 20;
      const rows = Math.ceil(g.nodes.length / cols);
      const height = rows * (NODE_H + GAP_Y) - GAP_Y + 20;
      return { nodes, edges, width, height };
    },
  },
  mounted() {
    this.initNodes();
    this.restoreDirs();
    // 订阅宿主 agent_changed 事件：切换 Agent 时同步刷新
    const on = typeof window !== "undefined" && window.__jarvisOn;
    if (typeof on === "function") {
      this._offAgentChanged = on("agent_changed", () => {
        this.refresh();
      });
    }
    // 3-5s 轮询状态（决策 9）
    this._pollTimer = setInterval(() => {
      this.pollStatus();
    }, POLL_INTERVAL);
    this.refresh();
  },
  beforeUnmount() {
    if (typeof this._offAgentChanged === "function") this._offAgentChanged();
    if (this._pollTimer) clearInterval(this._pollTimer);
  },
  watch: {
    workingDir() {
      this.refresh();
    },
  },
  methods: {
    // ---- 节点管理 ----
    // 加载节点列表（__jarvisGetNodes，master 恒在列），并恢复上次选中的节点
    initNodes() {
      const getNodes =
        typeof window !== "undefined" && window.__jarvisGetNodes;
      if (typeof getNodes !== "function") {
        this.nodes = [{ node_id: "master", status: "running" }];
        return;
      }
      try {
        const list = getNodes() || [];
        const nodes = Array.isArray(list)
          ? list.filter((n) => n && String(n.node_id || "").trim())
          : [];
        this.nodes = nodes.length ? nodes : [{ node_id: "master", status: "running" }];
      } catch (e) {
        this.nodes = [{ node_id: "master", status: "running" }];
      }
      const saved = (localStorage.getItem("jarvis_reversa_node") || "master").trim();
      this.nodeId = saved || "master";
      this.restoreDirs();
    },
    onNodeChange() {
      localStorage.setItem("jarvis_reversa_node", this.nodeId);
      this.restoreDirs();
      this.refresh();
    },
    // ---- 项目目录（localStorage 按节点持久化）----
    restoreDirs() {
      const raw = localStorage.getItem(dirsKey(this.nodeId));
      let dirs = [];
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) dirs = parsed;
      } catch (e) {
        dirs = [];
      }
      this.dirs = dirs.filter((d) => d && String(d).trim());
      const active = (localStorage.getItem(activeDirKey(this.nodeId)) || "").trim();
      this.projectDir = active || "";
      this.projectInput = this.projectDir;
      this.restoreRefs();
      this.scanNlspecs();
    },
    persistDirs() {
      localStorage.setItem(dirsKey(this.nodeId), JSON.stringify(this.dirs));
      if (this.projectDir) {
        localStorage.setItem(activeDirKey(this.nodeId), this.projectDir);
      } else {
        localStorage.removeItem(activeDirKey(this.nodeId));
      }
    },
    // ---- 现存资料库（localStorage 按节点+项目持久化，仅注入反构提示词）----
    // 恢复当前项目（this.projectDir）的资料列表；无项目时清空。
    restoreRefs() {
      if (!this.projectDir) {
        this.refs = [];
        return;
      }
      const raw = localStorage.getItem(refsKey(this.nodeId, this.projectDir));
      let refs = [];
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) refs = parsed;
      } catch (e) {
        refs = [];
      }
      this.refs = refs.filter(
        (r) => r && (r.type === "doc" || r.type === "web" || r.type === "dir") && String(r.value || "").trim(),
      );
    },
    persistRefs() {
      if (!this.projectDir) return;
      localStorage.setItem(refsKey(this.nodeId, this.projectDir), JSON.stringify(this.refs));
    },
    // 添加一条资料（去重：同类型同值不重复添加）
    addRef() {
      const value = (this.refInput || "").trim();
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      if (!value) {
        this.error = "请输入资料（文档路径 / 网页 URL / 目录路径）";
        return;
      }
      if (this.refs.some((r) => r.type === this.refType && r.value === value)) {
        this.message = "该资料已存在";
        this.refInput = "";
        return;
      }
      this.refs.push({ type: this.refType, value });
      this.persistRefs();
      this.message = `已添加${this.refType === "web" ? "网页" : this.refType === "dir" ? "目录" : "文档"}：${value}`;
      this.refInput = "";
    },
    // 删除一条资料
    removeRef(idx) {
      this.refs.splice(idx, 1);
      this.persistRefs();
    },
    // 用宿主目录选择弹窗挑选资料目录（dir 类型），填入输入框并直接添加
    async pickRefDir() {
      const pick =
        typeof window !== "undefined" && window.__jarvisPickDirectoryWithNode;
      if (typeof pick !== "function") {
        this.error = "宿主未提供目录选择通道，请手动填写目录路径";
        return;
      }
      try {
        const picked = await pick();
        if (!picked || !picked.path) {
          return;
        }
        this.refInput = picked.path;
        this.refType = "dir";
        this.addRef();
      } catch (e) {
        this.error = String((e && e.message) || e);
      }
    },
    // 用宿主目录选择弹窗挑选项目目录（返回路径+节点）。
    // 选择后同步切换节点并直接加入项目列表，无需手输。
    async pickProjectDir() {
      const pick =
        typeof window !== "undefined" && window.__jarvisPickDirectoryWithNode;
      if (typeof pick !== "function") {
        this.error = "宿主未提供目录选择通道，请手动填写项目目录路径";
        return;
      }
      try {
        const picked = await pick();
        if (!picked || !picked.path) {
          return;
        }
        // 目录选择带节点时，同步切换目标节点（该目录所在节点）
        if (picked.nodeId) {
          this.nodeId = picked.nodeId;
          this.onNodeChange();
        }
        this.projectInput = picked.path;
        this.addProject();
      } catch (e) {
        this.error = String((e && e.message) || e);
      }
    },
    // 添加项目目录（去重、最近使用在前、上限截断）
    addProject() {
      const dir = (this.projectInput || "").trim();
      if (!dir) {
        this.error = "请输入项目目录";
        return;
      }
      this.dirs = [dir, ...this.dirs.filter((d) => d !== dir)].slice(
        0,
        DIRS_HISTORY_MAX,
      );
      this.projectDir = dir;
      this.persistDirs();
      this.error = "";
      this.restoreRefs();
      this.scanNlspecs();
      this.refresh();
    },
    selectProject(dir) {
      this.projectDir = dir;
      this.projectInput = dir;
      this.persistDirs();
      this.restoreRefs();
      this.scanNlspecs();
      this.refresh();
    },
    removeProject(dir) {
      this.dirs = this.dirs.filter((d) => d !== dir);
      if (this.projectDir === dir) {
        this.projectDir = "";
        this.projectInput = "";
        localStorage.removeItem(activeDirKey(this.nodeId));
      }
      this.persistDirs();
      this.restoreRefs();
      this.nlspecs = [];
      this.refresh();
    },
    // 生成对指定项目执行 Reversa 规格逆向分析的任务描述。
    // 由 Jarvis Agent 依据 .agents/skills 的 Reversa skills（SKILL.md）编排执行 5 阶段，
    // 通过 reversa 工具做生命周期管理与产物导出。
    // 若项目配置了上游依赖（deps.json），注入上游路径与 read_artifact 指引，
    // 让 Agent 反构时可参考上游已生成的 _reversa_sdd/ 规格产物。
    async buildAnalysisPrompt(dir) {
      const lines = [
        `请对项目目录 ${dir} 执行 Reversa 规格逆向分析。`,
        "",
        "遵循 Reversa 逆向工程规则（.agents/skills 下的 SKILL.md，可 load_rule 加载）执行 5 阶段分析：",
        "1. 侦察（reconhecimento/Scout）：识别项目技术栈、模块划分与关键入口。",
        "2. 挖掘（escavacao/Archaeologist）：深入源码提取领域概念、实体与关系。",
        "3. 解读（interpretacao/Detective）：交叉验证推断，标注置信度（🟢CONFIRMED/🟡INFERRED/🔴GAP）。",
        "4. 生成（geracao/Architect）：产出结构化规格文档到 _reversa_sdd/（inventory/domain/architecture/sdd）。",
        "5. 评审（revisao/Writer）：复核规格完整性，补齐缺口。",
        "",
        "执行要求：",
        "- 若项目尚未安装 Reversa 工作区，先用 reversa 工具（action=install, project_dir=该目录）安装。",
        "- 用 reversa 工具（action=status）查看分析进度，action=artifacts/read_artifact 浏览产物。",
        "- 分析完成后用 reversa 工具（action=export_rules）把产物按置信度导出为 Jarvis rule 知识库。",
        "- 分析过程与结论请分阶段汇报，最终给出规格产物清单与置信度汇总。",
        "",
        "语言要求（重要，优先级高于 Reversa 模板默认值）：",
        "- 写入 _reversa_sdd/ 的所有规格文档（inventory/domain/architecture/sdd 等）必须使用简体中文撰写。",
        "- Reversa 的 skill 模板、agent 名、阶段名（reconhecimento/escavacao/interpretacao/geracao/revisao）、章节标题与正文示例默认是葡萄牙语，这些都不是产物语言要求。",
        "  除下列专有名词外，标题、正文、表格列名、说明文字一律译为简体中文；不要把葡萄牙语原样写进产物。",
        "- 与用户交互、阶段汇报、结论汇总也使用简体中文。",
        "- 以下内容保持原文不翻译：代码标识符、文件路径、命令、API/协议名、第三方库名、产品名（如 Jarvis/Reversa/CodeAgent）。",
        "- 若 .reversa/state.json 的 doc_language 与此处不一致，以此处要求为准。",
        "- 文档开头不要保留 Reversa 模板的葡语元信息（如 \"Gerado pelo agente ... Fase 3 — Interpretação\"），改写为中文（如 \"由 Architect 代理生成（Reversa 第 3 阶段 — 解读）\"）。",
      ];
      // 注入上游依赖参考（决策：Agent 读结构化 deps.json，不依赖图）
      try {
        const payload = await callFunction("get_dependencies", { project_dir: dir }, this.nodeId);
        const deps = (payload.data && payload.data.dependencies) || [];
        if (deps.length) {
          lines.push(
            "",
            "上游依赖参考：",
            "该项目依赖以下上游仓库，分析接口/领域/架构时可参考上游已生成的 _reversa_sdd/ 规格产物：",
          );
          deps.forEach((d) => {
            const name = d.name ? `（${d.name}）` : "";
            lines.push(`- 上游：${d.path}${name}`);
          });
          lines.push(
            "读取方式：用 reversa 工具 action=read_artifact, project_dir=<上游路径>, path=<产物相对路径>（如 architecture.md / sdd/domain.md）读取上游规格，作为接口/领域/架构定义的权威参考。",
            "若上游尚未生成产物，则基于源码自行推断并在结论中标注。",
          );
        }
      } catch (e) {
        // 读取依赖失败不阻断任务描述生成
      }
      // 注入现存资料库参考（决策：仅进提示词，Agent 自行读取路径/抓取 URL，不落盘到项目）
      const refs = this.refs.filter((r) => r && String(r.value || "").trim());
      if (refs.length) {
        lines.push(
          "",
          "现存资料库参考：",
          "以下是该项目已有的参考资料，反构时请结合这些资料（文档/网页/目录）交叉验证，作为领域/接口/架构的补充输入：",
        );
        refs.forEach((r) => {
          if (r.type === "web") {
            lines.push(`- 网页：${r.value}（按站点情况选择读取方式：普通公开网页用 read_webpage；内网/需登录的站点优先用专用工具或浏览器扩展（browser_ext）读取；无法读取时在结论中标注）`);
          } else if (r.type === "dir") {
            lines.push(`- 目录：${r.value}（浏览该目录下文档/源码，作为参考输入）`);
          } else {
            lines.push(`- 文档：${r.value}（用 read_code 读取该文件内容作为参考）`);
          }
        });
        lines.push(
          "说明：以上资料仅作分析参考，不要把资料内容当作项目源码本身；若资料与源码冲突，以源码为准并在结论中标注。",
        );
      }
      return lines.join("\n");
    },
    // 在当前活跃 Agent 中执行当前项目的规格逆向分析
    async handleInCurrentAgent(dir) {
      dir = dir || this.projectDir;
      if (!dir) {
        this.error = "请先选择项目目录";
        return;
      }
      if (!this.installed) {
        this.error = "请先安装 Reversa 工作区再开始逆向";
        return;
      }
      if (!this.projectReady) {
        this.error = this.projectBlockReason || "项目目录不可用";
        return;
      }
      const send =
        typeof window !== "undefined" && window.__jarvisSendToActiveAgent;
      if (typeof send !== "function") {
        this.message = "宿主未提供发送通道，无法在当前 Agent 中执行";
        return;
      }
      const prompt = await this.buildAnalysisPrompt(dir);
      const res = send(prompt);
      if (res && res.success) {
        this.message = `已把 ${dir} 的逆向分析提示词发送给当前 Agent`;
      } else {
        this.message = "失败: " + ((res && res.error) || "发送失败");
      }
    },
    // 创建新 Agent 执行当前项目的规格逆向分析（预填弹窗，用户确认/编辑后创建）
    async handleNewAgent(dir) {
      dir = dir || this.projectDir;
      if (!dir) {
        this.error = "请先选择项目目录";
        return;
      }
      if (!this.installed) {
        this.error = "请先安装 Reversa 工作区再开始逆向";
        return;
      }
      if (!this.projectReady) {
        this.error = this.projectBlockReason || "项目目录不可用";
        return;
      }
      const openModal =
        typeof window !== "undefined" && window.__jarvisOpenCreateAgentModal;
      const create =
        typeof window !== "undefined" && window.__jarvisCreateAgentForTask;
      if (typeof openModal !== "function" && typeof create !== "function") {
        this.message = "宿主未提供创建通道，无法创建 Agent";
        return;
      }
      this.busy = true;
      this.message = `正在创建 Agent 对 ${dir} 执行规格逆向分析…`;
      try {
        const prefill = {
          workingDir: dir,
          task: await this.buildAnalysisPrompt(dir),
          name: `Reversa 逆向分析`,
          nodeId: this.nodeId,
        };
        if (typeof openModal === "function") {
          const res = await openModal(prefill);
          if (res && res.confirmed) {
            this.message = `已创建 Agent 对 ${dir} 执行规格逆向分析`;
          } else {
            this.message = "已取消";
          }
        } else {
          const res = await create(prefill);
          if (res && res.success) {
            this.message = `已创建 Agent 对 ${dir} 执行规格逆向分析`;
          } else {
            this.message = "失败: " + ((res && res.error) || "创建失败");
          }
        }
      } catch (e) {
        this.message = "失败: " + String((e && e.message) || e);
      } finally {
        this.busy = false;
      }
    },
    // ---- NLSpec 管理（issue #14）----
    // 四要素标准标题（spec_writing 规范）
    NLSPEC_ELEMENTS: ["Goal", "Constraints", "Interfaces", "Non-goals"],
    // 扫描 .jarvis/.df/specs/ 下的 NLSpec，并逐个解析四要素完整性
    async scanNlspecs() {
      if (!this.projectDir || this.nlspecLoading) return;
      this.nlspecLoading = true;
      this.nlspecError = "";
      try {
        const payload = await callFunction("list_nlspecs", { project_dir: this.projectDir }, this.nodeId);
        const list = (payload.data && payload.data.specs) || [];
        const specs = [];
        for (const item of list) {
          try {
            const detail = await callFunction("get_nlspec", { project_dir: this.projectDir, name: item.name }, this.nodeId);
            const content = (detail.data && detail.data.content) || "";
            specs.push(Object.assign({}, item, { elements: this.parseNlspecElements(content) }));
          } catch (e) {
            specs.push(Object.assign({}, item, { elements: {} }));
          }
        }
        this.nlspecs = specs;
      } catch (e) {
        this.nlspecError = String((e && e.message) || e);
        this.nlspecs = [];
      } finally {
        this.nlspecLoading = false;
      }
    },
    // 客观解析 spec 内容中的四要素小节标题（缺失即视为不完整）
    parseNlspecElements(content) {
      const found = {};
      (this.NLSPEC_ELEMENTS || []).forEach((el) => {
        const re = new RegExp("^#{1,3}\\s+" + el + "\\s*$", "im");
        found[el] = re.test(content || "");
      });
      return found;
    },
    // 缺失的四要素列表（用于模板标红提示）
    missingElements(s) {
      const els = (this.NLSPEC_ELEMENTS || []).filter((el) => !(s && s.elements && s.elements[el]));
      return els;
    },
    // 创建 Agent 跑澄清流程（新建=空/草稿起步，编辑=以现有 spec 为输入补齐）
    async runClarifyAgent(name, isEdit) {
      if (!this.projectDir) return;
      const openModal =
        typeof window !== "undefined" && window.__jarvisOpenCreateAgentModal;
      const create =
        typeof window !== "undefined" && window.__jarvisCreateAgentForTask;
      if (typeof openModal !== "function" && typeof create !== "function") {
        this.message = "宿主未提供创建通道，无法创建 Agent";
        return;
      }
      this.nlspecBusy = true;
      const lines = [
        `请对项目 ${this.projectDir} 执行 NLSpec 澄清（<dark-factory/clarify> 流程）。`,
        "",
        "遵循 spec_writing 规则（可 load_rule 加载）识别 NLSpec 四要素（Goal/Constraints/Interfaces/Non-goals）中缺失、模糊或自相矛盾的部分，",
        "逐条向用户提问补齐，直到四要素完整、无模糊项。",
      ];
      if (isEdit) {
        lines.push(
          "",
          `现有 NLSpec 文件：.jarvis/.df/specs/${name}（用 read_code 读取，以其为输入补齐缺口并更新）。`,
        );
      }
      lines.push(
        "",
        isEdit
          ? `最终把完整 NLSpec 落盘到固定 spec 目录 .jarvis/.df/specs/${name}（澄清问答可一并留痕）。`
          : "最终把完整 NLSpec 落盘到固定 spec 目录 .jarvis/.df/specs/<功能名>.md（先与用户确认功能名，每功能一个 spec，澄清问答可一并留痕）。",
        "四要素完整后，引导进入 <dark-factory/run> 开始开发。",
      );
      const prefill = {
        workingDir: this.projectDir,
        task: lines.join("\n"),
        name: isEdit ? `NLSpec 澄清（${name}）` : "NLSpec 澄清（新建）",
        nodeId: this.nodeId,
      };
      try {
        if (typeof openModal === "function") {
          const res = await openModal(prefill);
          if (res && res.confirmed) {
            this.message = isEdit
              ? `已创建 Agent 澄清 ${name} 的 NLSpec`
              : "已创建 Agent 澄清新建 NLSpec";
          } else {
            this.message = "已取消";
          }
        } else {
          const res = await create(prefill);
          if (res && res.success) {
            this.message = isEdit
              ? `已创建 Agent 澄清 ${name} 的 NLSpec`
              : "已创建 Agent 澄清新建 NLSpec";
          } else {
            this.message = "失败: " + ((res && res.error) || "创建失败");
          }
        }
      } catch (e) {
        this.message = "失败: " + String((e && e.message) || e);
      } finally {
        this.nlspecBusy = false;
      }
    },
    // 新建 NLSpec：创建 Agent 跑澄清流程（从空/草稿起步）
    newNlspec() {
      this.runClarifyAgent("", false);
    },
    // 编辑 NLSpec：创建 Agent 以现有 spec 为输入跑澄清补齐四要素
    editNlspec(name) {
      if (!name) return;
      this.runClarifyAgent(name, true);
    },
    // 基于该 NLSpec 开启黑灯工厂流程（<dark-factory/run>，读固定 spec）
    async openNlspecPipeline(name) {
      if (!this.projectDir || !name) return;
      const spec = this.nlspecs.find((s) => s.name === name);
      const missing = spec ? this.missingElements(spec) : [];
      if (missing.length) {
        this.error = `NLSpec 四要素不完整（缺 ${missing.join("、")}），请先点「编辑」澄清补齐`;
        return;
      }
      const openModal =
        typeof window !== "undefined" && window.__jarvisOpenCreateAgentModal;
      const create =
        typeof window !== "undefined" && window.__jarvisCreateAgentForTask;
      if (typeof openModal !== "function" && typeof create !== "function") {
        this.message = "宿主未提供创建通道，无法创建 Agent";
        return;
      }
      this.nlspecBusy = true;
      const specPath = ".jarvis/.df/specs/" + name;
      const task = [
        `请基于 NLSpec 对项目 ${this.projectDir} 执行黑灯工厂流水线（<dark-factory/run>）。`,
        "",
        `先 read_code 读取固定 NLSpec 文件 ${specPath}，四要素不齐或模糊时先向用户澄清补齐。`,
        "再与用户讨论动态生成编排文件（参考 orchestration/dark_factory_pipeline.yaml 模板），",
        "把 NLSpec 内容写入编排文件顶层 spec 字段，落盘到 .jarvis/.df/pipeline.yaml，用户确认后",
        "用 pipeline_runner 工具驱动流水线（approve=false，门禁停住交人工审批）。",
      ].join("\n");
      const prefill = {
        workingDir: this.projectDir,
        task: task,
        name: `黑灯工厂（${name}）`,
        nodeId: this.nodeId,
      };
      try {
        if (typeof openModal === "function") {
          const res = await openModal(prefill);
          if (res && res.confirmed) {
            this.message = `已创建 Agent 基于 ${name} 开启黑灯工厂流程`;
          } else {
            this.message = "已取消";
          }
        } else {
          const res = await create(prefill);
          if (res && res.success) {
            this.message = `已创建 Agent 基于 ${name} 开启黑灯工厂流程`;
          } else {
            this.message = "失败: " + ((res && res.error) || "创建失败");
          }
        }
      } catch (e) {
        this.message = "失败: " + String((e && e.message) || e);
      } finally {
        this.nlspecBusy = false;
      }
    },
    // ---- 状态 ----
    async refresh() {
      this.loading = true;
      this.error = "";
      try {
        if (this.projectDir) {
          await this.loadProjectCheck();
          await this.loadStatus();
          await this.loadArtifacts();
          await this.loadSyncStatus();
        } else {
          this.status = null;
          this.artifacts = [];
          this.syncStatus = null;
          this.projectCheck = null;
        }
        await this.loadDepsGraph();
      } catch (e) {
        this.error = e.message || "刷新失败";
        this.status = null;
      } finally {
        this.loading = false;
      }
    },
    // 轮询：静默刷新状态（不打断用户操作）
    async pollStatus() {
      if (!this.projectDir || this.busy || this.loading) return;
      try {
        await this.loadStatus();
      } catch (e) {
        // 轮询失败静默（断线重连：下次轮询自动恢复）
      }
    },
    async loadStatus() {
      const payload = await callFunction("get_status", { project_dir: this.projectDir }, this.nodeId);
      this.status = payload.data || {};
    },
    // 检查项目目录前置条件（是否存在 / 是否 git 仓库），供按钮可用性限制
    async loadProjectCheck() {
      if (!this.projectDir) {
        this.projectCheck = null;
        return;
      }
      const dir = this.projectDir;
      this.projectCheckLoading = true;
      try {
        const payload = await callFunction("check_project", { project_dir: dir }, this.nodeId);
        const d = payload.data || {};
        // 期间切换了项目则丢弃过期结果
        if (this.projectDir !== dir) return;
        this.projectCheck = {
          path: dir,
          exists: d.exists !== false,
          is_git: !!d.is_git,
        };
      } catch (e) {
        if (this.projectDir !== dir) return;
        // 检查失败不阻断使用，仅记录原因
        this.projectCheck = {
          path: dir,
          exists: true,
          is_git: true,
          error: String((e && e.message) || e),
        };
      } finally {
        this.projectCheckLoading = false;
      }
    },
    // ---- 安装/卸载 ----
    async doInstall() {
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      this.busy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction(
          "install_project",
          {
            project_dir: this.projectDir,
            engine: "codex",
            chat_language: "zh-cn",
            doc_language: "中文",
          },
          this.nodeId,
        );
        this.message = `安装成功：${payload.data.version}，${payload.data.agents} 个 skills`;
        await this.loadStatus();
        await this.loadArtifacts();
      } catch (e) {
        this.error = e.message || "安装失败";
      } finally {
        this.busy = false;
      }
    },
    async doUninstall() {
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      if (!window.confirm("确定卸载 Reversa 工作区？_reversa_sdd/ 产物会保留。")) {
        return;
      }
      this.busy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction(
          "uninstall_project",
          { project_dir: this.projectDir, keep_output: true },
          this.nodeId,
        );
        this.message = `卸载完成：移除 ${payload.data.removed} 个文件`;
        await this.loadStatus();
        await this.loadArtifacts();
      } catch (e) {
        this.error = e.message || "卸载失败";
      } finally {
        this.busy = false;
      }
    },
    // ---- 产物浏览 ----
    async loadArtifacts() {
      const payload = await callFunction("list_artifacts", { project_dir: this.projectDir }, this.nodeId);
      this.artifacts = (payload.data && payload.data.files) || [];
    },
    // 树形展开/收起
    toggleDir(node) {
      this.artifactOpen[node.path] = !this.artifactOpen[node.path];
    },
    isDirOpen(node) {
      return !!this.artifactOpen[node.path];
    },
    async openArtifact(node) {
      if (node.type !== "file") return;
      this.artifactLoading = true;
      this.error = "";
      try {
        const payload = await callFunction(
          "read_artifact",
          { project_dir: this.projectDir, path: node.path },
          this.nodeId,
        );
        this.selectedArtifact = payload.data;
        this.artifactContent = payload.data.content || "";
      } catch (e) {
        this.error = e.message || "读取产物失败";
      } finally {
        this.artifactLoading = false;
      }
    },
    // 置信度徽标
    confidenceBadge(content) {
      if (!content) return "";
      if (content.includes(CONFIDENCE_GAP)) return CONFIDENCE_GAP;
      if (content.includes(CONFIDENCE_CONFIRMED)) return CONFIDENCE_CONFIRMED;
      if (content.includes(CONFIDENCE_INFERRED)) return CONFIDENCE_INFERRED;
      return "";
    },
    // ---- 导出 ----
    async doExportRules() {
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      if (!this.installed) {
        this.error = "请先安装 Reversa 工作区";
        return;
      }
      if (!this.hasArtifacts) {
        this.error = "暂无规格产物，请先运行 Reversa 逆向分析";
        return;
      }
      this.exportBusy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction(
          "export_rules",
          {
            project_dir: this.projectDir,
            include_gap: this.includeGap,
            include_unknown: true,
          },
          this.nodeId,
        );
        const d = payload.data || {};
        this.message = `导出 ${d.exported ? d.exported.length : 0} 条 rule 到 ${d.rule_dir || ""}` +
          (d.skipped && d.skipped.length ? `（跳过 ${d.skipped.length} 条）` : "");
      } catch (e) {
        this.error = e.message || "导出失败";
      } finally {
        this.exportBusy = false;
      }
    },
    // ---- 依赖图 ----
    // 聚合当前节点下所有项目目录的 deps.json，构建依赖图。
    // 节点=仓库目录；边 from→to 表示 from 依赖 to（箭头指向被依赖的上游）。
    async loadDepsGraph() {
      this.depsLoading = true;
      this.error = "";
      try {
        const paths = this.dirs.length ? this.dirs : (this.projectDir ? [this.projectDir] : []);
        const depsByPath = {};
        for (const p of paths) {
          try {
            const payload = await callFunction("get_dependencies", { project_dir: p }, this.nodeId);
            depsByPath[p] = (payload.data && payload.data.dependencies) || [];
          } catch (e) {
            depsByPath[p] = [];
          }
        }
        // 收集所有节点（项目目录 + 依赖的上游路径）
        const nodePaths = new Set(paths);
        Object.values(depsByPath).forEach((deps) => {
          deps.forEach((d) => {
            if (d && d.path) nodePaths.add(d.path);
          });
        });
        const nodes = Array.from(nodePaths).map((p) => ({
          path: p,
          label: baseName(p),
        }));
        // 边：from=依赖方，to=被依赖方（箭头指向被依赖的上游）
        const edges = [];
        Object.keys(depsByPath).forEach((from) => {
          depsByPath[from].forEach((d) => {
            if (d && d.path && d.path !== from) {
              edges.push({ from, to: d.path });
            }
          });
        });
        this.depsGraph = { nodes, edges };
      } catch (e) {
        this.error = e.message || "加载依赖图失败";
      } finally {
        this.depsLoading = false;
      }
    },
    // 用宿主目录选择弹窗挑选上游依赖目录（返回路径+节点）。
    // 依赖属于当前激活项目（当前节点），选择后填入输入框并直接添加，无需手输。
    async pickDependencyDir() {
      const pick =
        typeof window !== "undefined" && window.__jarvisPickDirectoryWithNode;
      if (typeof pick !== "function") {
        this.error = "宿主未提供目录选择通道，请手动填写上游依赖路径";
        return;
      }
      try {
        const picked = await pick();
        if (!picked || !picked.path) {
          return;
        }
        this.depInput = picked.path;
        this.addDependency();
      } catch (e) {
        this.error = String((e && e.message) || e);
      }
    },
    // 为当前激活项目添加一个上游依赖
    async addDependency() {
      const dep = (this.depInput || "").trim();
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      if (!dep) {
        this.error = "请输入上游依赖路径";
        return;
      }
      this.depBusy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction("get_dependencies", { project_dir: this.projectDir }, this.nodeId);
        const deps = (payload.data && payload.data.dependencies) || [];
        if (deps.some((d) => d.path === dep)) {
          this.message = "该依赖已存在";
          this.depInput = "";
          return;
        }
        deps.push({ path: dep });
        await callFunction("set_dependencies", { project_dir: this.projectDir, dependencies: deps }, this.nodeId);
        this.message = `已添加依赖：${dep}`;
        this.depInput = "";
        await this.loadDepsGraph();
      } catch (e) {
        this.error = e.message || "添加依赖失败";
      } finally {
        this.depBusy = false;
      }
    },
    // 删除当前激活项目的一个上游依赖
    async removeDependency(depPath) {
      if (!this.projectDir) return;
      this.depBusy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction("get_dependencies", { project_dir: this.projectDir }, this.nodeId);
        const deps = ((payload.data && payload.data.dependencies) || []).filter((d) => d.path !== depPath);
        await callFunction("set_dependencies", { project_dir: this.projectDir, dependencies: deps }, this.nodeId);
        this.message = `已移除依赖：${depPath}`;
        await this.loadDepsGraph();
      } catch (e) {
        this.error = e.message || "移除依赖失败";
      } finally {
        this.depBusy = false;
      }
    },
    // 当前激活项目已配置的依赖（供列表展示/删除）
    activeDeps() {
      if (!this.depsGraph || !this.projectDir) return [];
      const node = this.depsGraph.nodes.find((n) => n.path === this.projectDir);
      if (!node) return [];
      return this.depsGraph.edges.filter((e) => e.from === this.projectDir).map((e) => e.to);
    },
    // ---- 知识回流（sync）----
    // 加载当前项目的同步状态（基线是否存在/文档是否过期/产物是否被手工编辑）
    async loadSyncStatus() {
      if (!this.projectDir) {
        this.syncStatus = null;
        return;
      }
      try {
        const payload = await callFunction(
          "get_sync_status",
          { project_dir: this.projectDir },
          this.nodeId,
        );
        this.syncStatus = payload.data || null;
      } catch (e) {
        this.syncStatus = null;
      }
    },
    // 记录知识回流基线（把当前 commit + 产物 hash 固化为基线）
    async doRecordBaseline() {
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      if (!this.installed) {
        this.error = "请先安装 Reversa 工作区";
        return;
      }
      if (!this.hasArtifacts) {
        this.error = "暂无规格产物，请先运行 Reversa 逆向分析";
        return;
      }
      if (!this.isGitRepo) {
        this.error = "项目不是 git 仓库，无法记录 commit 基线";
        return;
      }
      this.syncBusy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction(
          "record_sync_baseline",
          { project_dir: this.projectDir },
          this.nodeId,
        );
        const d = payload.data || {};
        this.message = `已记录基线：${d.base_commit}（${(d.artifacts && Object.keys(d.artifacts).length) || 0} 个产物）`;
        await this.loadSyncStatus();
      } catch (e) {
        this.error = e.message || "记录基线失败";
      } finally {
        this.syncBusy = false;
      }
    },
    // 分析知识回流差异（基线 commit → 当前 HEAD 的代码变更 → 受影响产物）
    async doAnalyzeSync() {
      if (!this.projectDir) {
        this.error = "请先选择项目目录";
        return;
      }
      if (!this.isGitRepo) {
        this.error = "项目不是 git 仓库，无法比对代码变更";
        return;
      }
      if (!(this.syncStatus && this.syncStatus.has_baseline)) {
        this.error = "请先「记录基线」再分析差异";
        return;
      }
      this.syncBusy = true;
      this.error = "";
      this.message = "";
      try {
        const payload = await callFunction(
          "analyze_sync_diff",
          { project_dir: this.projectDir },
          this.nodeId,
        );
        const d = payload.data || {};
        if (d.up_to_date) {
          this.message = "文档与代码已同步（无代码变更）";
        } else {
          this.message = `发现 ${(d.changed_files || []).length} 个代码文件变更，影响 ${(d.affected_artifacts || []).length} 个产物` +
            (d.affected_artifacts && d.affected_artifacts.length ? `：${d.affected_artifacts.join(", ")}` : "");
        }
        await this.loadSyncStatus();
      } catch (e) {
        this.error = e.message || "分析差异失败";
      } finally {
        this.syncBusy = false;
      }
    },
  },
  template: `
  <div style="display:flex;flex-direction:column;height:100%;font-size:12px;color:#ddd;overflow-y:auto;overflow-x:hidden;">
    <!-- 头部 -->
    <div style="padding:8px 10px;border-bottom:1px solid #333;display:flex;align-items:center;gap:6px;flex-shrink:0;">
      <span style="font-weight:bold;font-size:13px;">🏭 黑灯工厂</span>
      <span style="flex:1;"></span>
      <select v-model="nodeId" @change="onNodeChange"
        style="padding:3px 6px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px;font-size:11px;">
        <option v-for="n in nodes" :key="n.node_id" :value="n.node_id">{{ n.node_id }}</option>
      </select>
      <button @click="helpVisible = true" title="使用说明"
        style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;">?</button>
    </div>
    <!-- 使用说明：黑灯工厂完整闭环（可折叠） -->
    <div style="padding:6px 10px;border-bottom:1px solid #333;flex-shrink:0;">
      <div @click="guideVisible = !guideVisible"
        style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:#888;user-select:none;">
        <span style="color:#79c0ff;">{{ guideVisible ? '▾' : '▸' }}</span>
        <span style="font-weight:bold;">黑灯工厂使用说明</span>
        <span style="flex:1;"></span>
        <span style="font-size:10px;color:#666;">{{ guideVisible ? '点击收起' : '点击展开' }}</span>
      </div>
      <div v-if="guideVisible" style="margin-top:6px;">
        <!-- 快速上手：照着点即可走通全流程（区块名 + 按钮名） -->
        <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:11px;line-height:1.8;color:#c9d1d9;">
          <div style="font-weight:bold;color:#79c0ff;margin-bottom:2px;">🚀 快速上手（照着点）</div>
          <div><b>1.</b> 「① 项目」→ 输入目录或点「选择目录」，再点「添加」</div>
          <div><b>2.</b> 「② 逆向分析」→ 点「安装 Reversa」（Agent 也会自动装，纯新项目可跳过）</div>
          <div><b>3.</b> 「② 逆向分析」→ 可选：先在 2.2 加上游依赖（2.3 看依赖图）、2.4 加现存资料，逆向时会参考</div>
          <div><b>4.</b> 「② 逆向分析」→ 点「🚀 开始逆向（新建 Agent）」，等 5 阶段跑完</div>
          <div><b>5.</b> 「② 逆向分析」→ 浏览「规格产物」，需要时点「导出 Rules」</div>
          <div><b>6.</b> 「③ 正向开发」→ 点「新建」让 Agent 澄清需求（或已有 spec 直接点「开启」）</div>
          <div><b>7.</b> 流水线跑完即完成——「④ 知识回流」会自动记录基线并同步文档</div>
          <div style="color:#8b949e;margin-top:2px;">详细原理见下方闭环图与各区块说明。</div>
        </div>
        <!-- 闭环图：逆向分析 → 正向开发 → 知识回流 -->
        <svg viewBox="0 0 376 150" width="100%" style="display:block;max-width:100%;height:auto;background:#0d1117;border:1px solid #30363d;border-radius:6px;">
          <!-- 三条主流程节点（明细文字内嵌节点，避免互相重叠） -->
          <rect x="8" y="18" width="104" height="60" rx="6" fill="#1f6feb" fill-opacity="0.18" stroke="#1f6feb" stroke-width="1"/>
          <text x="60" y="37" text-anchor="middle" font-size="10" fill="#79c0ff" font-weight="bold">① 逆向分析</text>
          <text x="60" y="54" text-anchor="middle" font-size="6.5" fill="#8b949e">侦察→挖掘→解读→生成→评审</text>

          <rect x="136" y="18" width="104" height="60" rx="6" fill="#238636" fill-opacity="0.18" stroke="#238636" stroke-width="1"/>
          <text x="188" y="37" text-anchor="middle" font-size="10" fill="#3fb950" font-weight="bold">② 正向开发</text>
          <text x="188" y="54" text-anchor="middle" font-size="6.5" fill="#8b949e">规划→场景→生成→验证→回归→门禁</text>

          <rect x="264" y="18" width="104" height="60" rx="6" fill="#9e6a03" fill-opacity="0.18" stroke="#9e6a03" stroke-width="1"/>
          <text x="316" y="37" text-anchor="middle" font-size="10" fill="#d29922" font-weight="bold">③ 知识回流</text>
          <text x="316" y="54" text-anchor="middle" font-size="6.5" fill="#8b949e">基线→差异→增量→导出</text>

          <!-- 主流程箭头 ①→②→③ -->
          <path d="M112 48 H136" stroke="#8b949e" stroke-width="1.5" marker-end="url(#dfArrow)"/>
          <path d="M240 48 H264" stroke="#8b949e" stroke-width="1.5" marker-end="url(#dfArrow)"/>

          <!-- 回流箭头 ③→①（闭环，走底部大圆弧，避开文字） -->
          <path d="M316 78 C 316 132, 60 132, 60 78" fill="none" stroke="#d29922" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#dfArrowBack)"/>

          <!-- 底部说明（回流弧线下方） -->
          <text x="188" y="142" text-anchor="middle" font-size="8.5" fill="#6e7681">Specs 进，可工作的软件出 · 人类审 pass/fail 报告 · 逆向→正向→回流闭环</text>

          <defs>
            <marker id="dfArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b949e"/>
            </marker>
            <marker id="dfArrowBack" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#d29922"/>
            </marker>
          </defs>
        </svg>
        <!-- 文字说明 -->
        <div style="margin-top:6px;font-size:11px;line-height:1.7;color:#c9d1d9;">
          <div><b style="color:#79c0ff;">① 逆向分析</b>：对遗留项目执行 Reversa 逆向（<code style="color:#79c0ff;">reversa</code> 工具 install → analyze），生成 <code style="color:#79c0ff;">_reversa_sdd/</code> 结构化规格。</div>
          <div><b style="color:#3fb950;">② 正向开发</b>：让 Agent 用 <code style="color:#79c0ff;">pipeline_runner</code> 跑黑灯工厂流水线（<code style="color:#79c0ff;">&lt;dark-factory/run&gt;</code> 指令模板），门禁停住交人工审批。</div>
          <div><b style="color:#d29922;">③ 知识回流</b>：流水线末尾 <code style="color:#79c0ff;">sync</code> 记录基线、分析代码变更对产物的影响并更新，保持文档与代码同步。</div>
          <div style="margin-top:4px;color:#8b949e;">下方控件按「① 项目 → ② 逆向分析 → ③ 正向开发 → ④ 知识回流」排列，自上而下即为执行顺序。</div>
        </div>
      </div>
    </div>
    <!-- 项目区 -->
    <div style="padding:8px 10px;border-bottom:1px solid #333;flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="font-size:11px;font-weight:bold;color:#79c0ff;">① 项目</span>
        <span style="font-size:10px;color:#666;">选择要操作的项目目录</span>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:4px;">
        <input v-model="projectInput" placeholder="输入项目目录（如 /path/to/legacy）"
          @keydown.enter.prevent="addProject"
          style="flex:1;min-width:0;padding:4px 6px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px;font-size:12px;">
        <button @click="pickProjectDir" title="用目录选择弹窗挑选项目目录"
          style="padding:4px 10px;background:#333;color:#ddd;border:none;border-radius:4px;cursor:pointer;font-size:12px;">选择目录</button>
        <button @click="addProject" :disabled="busy"
          style="padding:4px 10px;background:#1f6feb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">添加</button>
      </div>
      <div v-if="dirs.length" style="display:flex;flex-wrap:wrap;gap:4px;">
        <span v-for="d in dirs" :key="d" @click="selectProject(d)"
          :title="d"
          :style="{display:'inline-flex',alignItems:'center',gap:'3px',padding:'2px 6px',borderRadius:'10px',cursor:'pointer',fontSize:'11px',maxWidth:'180px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',background: d === projectDir ? '#1f6feb' : '#2d2d2d', color: d === projectDir ? '#fff' : '#aaa'}">
          {{ d }}
          <span @click.stop="removeProject(d)" style="color:inherit;opacity:.7;">×</span>
        </span>
      </div>
    </div>
    <!-- ② 逆向分析 -->
    <div v-if="projectDir" style="border-bottom:1px solid #333;flex-shrink:0;">
      <div style="padding:8px 10px 4px;display:flex;align-items:center;gap:6px;">
        <span style="font-size:11px;font-weight:bold;color:#79c0ff;">② 逆向分析</span>
        <span style="font-size:10px;color:#666;">安装 → 跑 5 阶段 → 看产物</span>
      </div>

    <!-- ② 逆向分析：安装状态 + 输入配置 + 执行 + 进度 -->
    <div v-if="projectDir" style="border-bottom:1px solid #333;flex-shrink:0;">
      <div style="padding:0 10px;display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="font-size:11px;color:#aaa;">2.1 工作区状态</span>
        <span v-if="loading" style="color:#888;">加载中…</span>
        <span v-else-if="installed" style="color:#3fb950;">已安装 v{{ status.version }}</span>
        <span v-else style="color:#d29922;">未安装</span>
        <span style="flex:1;"></span>
        <button @click="refresh" :disabled="busy" title="刷新"
          style="padding:3px 8px;background:#2d2d2d;color:#ddd;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:11px;">刷新</button>
      </div>
      <!-- 前置条件提示：项目目录不可用 / 非 git 仓库 -->
      <div v-if="!projectReady" style="padding:0 10px 6px;font-size:11px;color:#f85149;">
        ⚠ {{ projectBlockReason }}
      </div>
      <div v-else-if="!isGitRepo" style="padding:0 10px 6px;font-size:11px;color:#d29922;">
        ⚠ 当前项目不是 git 仓库：「④ 知识回流」的记录基线/分析差异不可用（逆向分析与正向开发不受影响）
      </div>
      <!-- 2.2 上游依赖（逆向输入：分析时 Agent 会参考上游规格产物） -->
      <div style="padding:0 10px 8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:4px;">2.2 上游依赖
          <span style="color:#666;">（建议先配置：逆向时会参考上游 _reversa_sdd/ 规格）</span>
        </div>
        <div style="display:flex;gap:4px;margin-bottom:4px;">
          <input v-model="depInput" placeholder="上游依赖目录（如 /path/to/upstream）"
            @keydown.enter.prevent="addDependency"
            style="flex:1;min-width:0;padding:3px 6px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px;font-size:11px;">
          <button @click="pickDependencyDir" title="用目录选择弹窗挑选上游依赖目录"
            style="padding:3px 10px;background:#333;color:#ddd;border:none;border-radius:4px;cursor:pointer;font-size:11px;">选择目录</button>
          <button @click="addDependency" :disabled="depBusy"
            style="padding:3px 10px;background:#1f6feb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">添加依赖</button>
        </div>
        <div v-if="activeDeps().length" style="display:flex;flex-wrap:wrap;gap:4px;">
          <span v-for="dep in activeDeps()" :key="dep" :title="dep"
            style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:10px;background:#2d2d2d;color:#aaa;font-size:11px;max-width:180px;overflow:hidden;textOverflow:ellipsis;whiteSpace:nowrap;">
            {{ baseName(dep) }}
            <span @click="removeDependency(dep)" style="cursor:pointer;opacity:.7;" title="移除依赖">×</span>
          </span>
        </div>
      </div>
    <!-- 2.3 依赖图（与 2.2 配套：配置 + 可视化） -->
    <div style="padding:0 10px 8px;">
      <div style="font-size:11px;color:#aaa;display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span>2.3 依赖图</span>
        <span style="font-size:10px;color:#666;">（箭头指向被依赖的上游）</span>
        <span style="flex:1;"></span>
        <button @click="loadDepsGraph" :disabled="depsLoading" title="刷新依赖图"
          style="padding:2px 8px;background:#2d2d2d;color:#ddd;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:11px;">
          {{ depsLoading ? '加载中…' : '刷新' }}
        </button>
      </div>
      <div v-if="depsLayout" style="overflow:auto;margin-bottom:4px;">
        <svg :width="depsLayout.width" :height="depsLayout.height" style="display:block;">
          <!-- 边（箭头指向被依赖方） -->
          <line v-for="e in depsLayout.edges" :key="e.from + '->' + e.to"
            :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2"
            stroke="#7d8590" stroke-width="1.5" marker-end="url(#reversaArrow)"/>
          <!-- 节点 -->
          <g v-for="n in depsLayout.nodes" :key="n.path">
            <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="6"
              :fill="n.path === projectDir ? '#1f6feb' : '#2d2d2d'" stroke="#444" stroke-width="1"/>
            <text :x="n.x + n.w / 2" :y="n.y + n.h / 2" text-anchor="middle" dominant-baseline="central"
              :fill="n.path === projectDir ? '#fff' : '#ccc'" font-size="11" style="pointer-events:none;">{{ n.label }}</text>
            <title>{{ n.path }}</title>
          </g>
        </svg>
        <svg width="0" height="0" style="position:absolute;">
          <defs>
            <marker id="reversaArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#7d8590"/>
            </marker>
          </defs>
        </svg>
      </div>
      <div v-else style="color:#666;font-size:11px;margin-bottom:4px;">
        {{ depsLoading ? '加载依赖图…' : '暂无依赖（在上方 2.2 为当前项目添加上游依赖）' }}
      </div>
    </div>
      <!-- 2.4 现存资料库（逆向输入：仅注入提示词，不落盘到项目） -->
      <div style="padding:0 10px 8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:4px;">2.4 现存资料库
          <span style="color:#666;">（建议先配置：反构时注入提示词作参考）</span>
        </div>
        <div style="display:flex;gap:4px;margin-bottom:4px;">
          <select v-model="refType" title="资料类型"
            style="padding:3px 4px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px;font-size:11px;">
            <option value="doc">文档</option>
            <option value="web">网页</option>
            <option value="dir">目录</option>
          </select>
          <input v-model="refInput" :placeholder="refType === 'web' ? '网页 URL（如 https://example.com/doc）' : (refType === 'dir' ? '目录路径（如 /path/to/docs）' : '文档路径（如 /path/to/spec.md）')"
            @keydown.enter.prevent="addRef"
            style="flex:1;min-width:0;padding:3px 6px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px;font-size:11px;">
          <button v-if="refType === 'dir'" @click="pickRefDir" title="用目录选择弹窗挑选资料目录"
            style="padding:3px 10px;background:#333;color:#ddd;border:none;border-radius:4px;cursor:pointer;font-size:11px;">选择目录</button>
          <button @click="addRef" :disabled="refBusy"
            style="padding:3px 10px;background:#1f6feb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;">添加</button>
        </div>
        <div v-if="refs.length" style="display:flex;flex-wrap:wrap;gap:4px;">
          <span v-for="(r, idx) in refs" :key="r.type + ':' + r.value" :title="r.value"
            style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:10px;background:#2d2d2d;color:#aaa;font-size:11px;max-width:200px;overflow:hidden;textOverflow:ellipsis;whiteSpace:nowrap;">
            <span style="font-size:10px;">{{ r.type === 'web' ? '🌐' : (r.type === 'dir' ? '📁' : '📄') }}</span>
            {{ r.type === 'web' ? r.value : baseName(r.value) }}
            <span @click="removeRef(idx)" style="cursor:pointer;opacity:.7;" title="移除资料">×</span>
          </span>
        </div>
      </div>
      <!-- 2.5 执行逆向（两个入口）+ 安装/卸载 -->
      <div style="padding:0 10px 8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:4px;">2.5 执行逆向</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button @click="handleNewAgent()" :disabled="!canStartAnalysis"
            :title="startAnalysisBlockReason || '创建新 Agent 执行规格逆向分析（推荐）'"
            :style="{padding:'5px 12px',background: canStartAnalysis ? '#1f6feb' : '#2d2d2d', color: canStartAnalysis ? '#fff' : '#777', border:'none', borderRadius:'4px', cursor: canStartAnalysis ? 'pointer' : 'not-allowed', fontSize:'12px'}">
            🚀 开始逆向（新建 Agent）
          </button>
          <button @click="handleInCurrentAgent()" :disabled="!canStartAnalysis"
            :title="startAnalysisBlockReason || '把逆向分析提示词发送给当前 Agent 执行'"
            :style="{padding:'5px 12px',background:'#2d2d2d',color: canStartAnalysis ? '#ddd' : '#777',border:'1px solid #444',borderRadius:'4px',cursor: canStartAnalysis ? 'pointer' : 'not-allowed',fontSize:'12px'}">
            在当前 Agent 中执行逆向
          </button>
          <button v-if="!installed" @click="doInstall" :disabled="busy || loading || !projectReady"
            :title="projectReady ? '安装 Reversa 工作区（.reversa/ 与 .agents/skills/）' : (projectBlockReason || '项目目录不可用')"
            style="padding:5px 12px;background:#238636;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
            {{ busy ? '安装中…' : '安装 Reversa' }}
          </button>
          <button v-if="installed" @click="doUninstall" :disabled="busy || loading"
            style="padding:5px 12px;background:#da3633;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
            {{ busy ? '卸载中…' : '卸载' }}
          </button>
        </div>
        <!-- 前置条件提示：未安装时明确告知为什么不能开始逆向 -->
        <div v-if="!installed" style="margin-top:4px;font-size:11px;color:#d29922;">
          未安装 Reversa 工作区，需先点「安装 Reversa」才能开始逆向。
        </div>
      </div>
      <!-- 阶段进度条 -->
      <div v-if="installed" style="padding:0 10px;font-size:11px;color:#aaa;margin-bottom:4px;">2.6 分析进度</div>
      <div v-if="installed" style="padding:0 10px;display:flex;gap:2px;margin-bottom:6px;">
        <div v-for="p in phaseList" :key="p.key" :title="p.key"
          :style="{flex:'1',height:'6px',borderRadius:'3px',background: p.state === 'done' ? '#3fb950' : (p.state === 'current' ? '#1f6feb' : '#333')}">
        </div>
      </div>
      <div v-if="installed" style="padding:0 10px;display:flex;gap:6px;font-size:11px;color:#888;margin-bottom:6px;flex-wrap:wrap;">
        <span v-for="p in phaseList" :key="p.key"
          :style="{color: p.state === 'done' ? '#3fb950' : (p.state === 'current' ? '#79c0ff' : '#888')}">
          {{ p.state === 'done' ? '✓' : (p.state === 'current' ? '▶' : '○') }} {{ p.label }}
        </span>
      </div>
      <div v-if="installed" style="padding:0 10px 8px;font-size:11px;color:#888;">
        项目：{{ status.project }} · 语言：{{ status.chat_language }} · 输出：{{ status.output_folder }}
      </div>
    </div>
    <!-- 产物浏览 -->
    <div style="padding:0 10px 8px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="font-size:11px;color:#aaa;">2.7 规格产物 <span style="color:#666;">（_reversa_sdd/）</span></span>
        <span style="flex:1;"></span>
        <button @click="doExportRules" :disabled="!canExportRules"
          :title="exportBlockReason || '把 _reversa_sdd/ 产物导出为可检索的 Jarvis rule（跨项目复用才需要，本项目闭环可直接读产物）'"
          :style="{padding:'3px 10px',background: canExportRules ? '#1f6feb' : '#2d2d2d', color: canExportRules ? '#fff' : '#777', border:'none', borderRadius:'4px', cursor: canExportRules ? 'pointer' : 'not-allowed', fontSize:'11px'}">
          {{ exportBusy ? '导出中…' : '导出 Rules' }}
        </button>
      </div>
      <label v-if="installed" style="display:flex;align-items:center;gap:4px;margin-bottom:4px;font-size:11px;color:#888;cursor:pointer;">
        <input type="checkbox" v-model="includeGap"> 导出 🔴GAP（默认只导出 🟢CONFIRMED/🟡INFERRED）
      </label>
      <!-- 导出 Rules 用途说明（可折叠）：解释这步是干什么的、什么时候需要 -->
      <div style="margin-bottom:4px;">
        <span @click="exportHelpVisible = !exportHelpVisible"
          style="font-size:11px;color:#79c0ff;cursor:pointer;user-select:none;">
          {{ exportHelpVisible ? '▾' : '▸' }} 导出 Rules 是做什么的？
        </span>
        <div v-if="exportHelpVisible"
          style="margin-top:4px;padding:6px 8px;background:#0d1117;border:1px solid #30363d;border-radius:4px;font-size:11px;line-height:1.7;color:#8b949e;">
          <div><b style="color:#c9d1d9;">做什么</b>：把 <code style="color:#79c0ff;">_reversa_sdd/</code> 下的规格文档复制一份到
            <code style="color:#79c0ff;">.jarvis/rules/reversa/artifacts/</code>，并加上 name/description/置信度等元信息，
            使其成为 Jarvis 可检索的 rule（知识库条目）。</div>
          <div><b style="color:#c9d1d9;">什么时候需要</b>：想让这套领域知识在<b>其它项目</b>里被 Agent 复用、或被规则检索命中时才需要。</div>
          <div><b style="color:#d29922;">什么时候不需要</b>：只在本项目跑「逆向 → 正向开发 → 知识回流」闭环时<b>不需要</b>——
            正向开发时 Agent 直接 <code style="color:#79c0ff;">read_code</code> 读 <code style="color:#79c0ff;">_reversa_sdd/</code> 里的原文即可，更准也没有副本。</div>
          <div style="color:#6e7681;">注意：导出是<b>一次性复制</b>，产物后续更新不会自动同步，需要重新导出。</div>
        </div>
      </div>
      <div style="max-height:220px;overflow:auto;border:1px solid #333;border-radius:4px;background:#1a1a1a;">
        <div v-if="!artifacts.length" style="padding:8px;color:#666;font-size:11px;">
          {{ installed ? '暂无产物，请运行 Reversa 分析' : '安装后运行 Reversa 分析生成产物' }}
        </div>
        <div v-for="node in artifacts" :key="node.path">
          <!-- 目录 -->
          <div v-if="node.type === 'dir'" @click="toggleDir(node)"
            style="padding:3px 10px;cursor:pointer;color:#79c0ff;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            {{ isDirOpen(node) ? '▾' : '▸' }} 📁 {{ node.name }}
          </div>
          <div v-if="node.type === 'dir' && isDirOpen(node)" style="padding-left:14px;">
            <div v-for="child in node.children" :key="child.path">
              <div v-if="child.type === 'dir'" @click="toggleDir(child)"
                style="padding:3px 10px;cursor:pointer;color:#79c0ff;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                {{ isDirOpen(child) ? '▾' : '▸' }} 📁 {{ child.name }}
              </div>
              <div v-if="child.type === 'dir' && isDirOpen(child)" style="padding-left:14px;">
                <div v-for="g in child.children" :key="g.path" @click="openArtifact(g)"
                  :style="{padding:'3px 10px',cursor:'pointer',fontSize:'12px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',color: selectedArtifact && selectedArtifact.path === g.path ? '#1f6feb' : '#ddd'}">
                  📄 {{ g.name }}
                  <span v-if="confidenceBadge(g.path)" style="margin-left:4px;font-size:10px;"></span>
                </div>
              </div>
              <div v-else @click="openArtifact(child)"
                :style="{padding:'3px 10px',cursor:'pointer',fontSize:'12px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',color: selectedArtifact && selectedArtifact.path === child.path ? '#1f6feb' : '#ddd'}">
                📄 {{ child.name }}
              </div>
            </div>
          </div>
          <!-- 文件 -->
          <div v-else @click="openArtifact(node)"
            :style="{padding:'3px 10px',cursor:'pointer',fontSize:'12px',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',color: selectedArtifact && selectedArtifact.path === node.path ? '#1f6feb' : '#ddd'}">
            📄 {{ node.name }}
          </div>
        </div>
      </div>
      <!-- 产物内容预览（就地展开） -->
      <div v-if="selectedArtifact" style="margin-top:4px;border:1px solid #333;border-radius:4px;max-height:260px;display:flex;flex-direction:column;">
        <div style="padding:4px 8px;font-size:11px;color:#888;display:flex;align-items:center;gap:6px;border-bottom:1px solid #333;">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ selectedArtifact.path }}</span>
          <span v-if="confidenceBadge(selectedArtifact.content)" style="font-size:10px;">{{ confidenceBadge(selectedArtifact.content) }}</span>
          <button @click="selectedArtifact = null; artifactContent = ''"
            style="background:none;border:none;color:#888;cursor:pointer;font-size:12px;">×</button>
        </div>
        <pre style="flex:1;overflow:auto;margin:0;padding:8px;font-size:11px;color:#ccc;white-space:pre-wrap;word-break:break-word;">{{ artifactContent }}</pre>
      </div>
      </div>
    </div>

    <!-- ③ 正向开发（NLSpec 管理，固定目录 .jarvis/.df/specs/） -->
    <div v-if="projectDir" style="padding:8px 10px;border-bottom:1px solid #333;flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
        <span style="font-size:11px;font-weight:bold;color:#3fb950;">③ 正向开发</span>
        <span style="font-size:10px;color:#666;">NLSpec 进，流水线出软件</span>
        <span style="flex:1;"></span>
        <button @click="scanNlspecs" :disabled="nlspecLoading" title="重新扫描工作区 NLSpec"
          style="padding:3px 8px;background:#2d2d2d;color:#ddd;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:11px;">扫描</button>
        <button @click="newNlspec" :disabled="nlspecBusy || !projectReady"
          :title="projectReady ? '新建 NLSpec（创建 Agent 跑澄清流程）' : (projectBlockReason || '项目目录不可用')"
          :style="{padding:'3px 8px',background: (nlspecBusy || !projectReady) ? '#2d2d2d' : '#1f6feb', color: (nlspecBusy || !projectReady) ? '#777' : '#fff', border:'none', borderRadius:'4px', cursor: (nlspecBusy || !projectReady) ? 'not-allowed' : 'pointer', fontSize:'11px'}">新建</button>
      </div>
      <div style="font-size:10px;color:#666;margin-bottom:4px;">NLSpec 存放于 .jarvis/.df/specs/</div>
      <div v-if="nlspecLoading" style="color:#888;font-size:11px;">扫描中…</div>
      <div v-else-if="!nlspecs.length" style="color:#666;font-size:11px;">未发现 NLSpec，点击「新建」创建</div>
      <div v-else style="display:flex;flex-direction:column;gap:4px;">
        <div v-for="s in nlspecs" :key="s.name"
          style="display:flex;align-items:center;gap:6px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;font-size:11px;">
          <span style="flex:1;min-width:0;overflow:hidden;textOverflow:ellipsis;whiteSpace:nowrap;color:#ddd;" :title="s.name">
            {{ s.title || s.name }}
          </span>
          <span v-if="missingElements(s).length" :title="'缺少：' + missingElements(s).map(e => '## ' + e).join('、')"
            style="color:#d29922;cursor:default;font-size:10px;">⚠ 缺 {{ missingElements(s).length }} 要素</span>
          <span v-else style="color:#3fb950;font-size:10px;">✓ 完整</span>
          <button @click="editNlspec(s.name)" :disabled="nlspecBusy" title="编辑（创建 Agent 跑澄清补齐四要素）"
            style="padding:2px 6px;background:#333;color:#ddd;border:none;border-radius:4px;cursor:pointer;font-size:10px;">编辑</button>
          <button @click="openNlspecPipeline(s.name)" :disabled="nlspecBusy || missingElements(s).length > 0"
            :title="missingElements(s).length ? '四要素不完整，请先点「编辑」澄清补齐：' + missingElements(s).join('、') : '基于该 NLSpec 开启黑灯工厂流程'"
            :style="{padding:'2px 6px',background: (nlspecBusy || missingElements(s).length) ? '#2d2d2d' : '#1f6feb', color: (nlspecBusy || missingElements(s).length) ? '#777' : '#fff', border:'none', borderRadius:'4px', cursor: (nlspecBusy || missingElements(s).length) ? 'not-allowed' : 'pointer', fontSize:'10px'}">开启</button>
        </div>
      </div>
    </div>
    <!-- ④ 知识回流 -->
    <div v-if="projectDir && installed" style="padding:8px 10px;border-bottom:1px solid #333;flex-shrink:0;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="font-size:11px;font-weight:bold;color:#d29922;">④ 知识回流</span>
        <span style="font-size:10px;color:#666;">保持文档与代码同步</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:4px;flex-wrap:wrap;">
        <template v-if="syncStatus && syncStatus.has_baseline">
          <span :style="{color: syncStatus.stale ? '#d29922' : '#3fb950'}">
            {{ syncStatus.stale ? '⚠ 文档过期' : '✓ 已同步' }}
          </span>
          <span style="color:#666;" :title="'基线：' + syncStatus.base_commit + ' → 当前：' + (syncStatus.head_commit || '?')">
            {{ syncStatus.base_commit }} → {{ syncStatus.head_commit || '?' }}
          </span>
        </template>
        <span v-else style="color:#666;">未记录基线</span>
        <span style="flex:1;"></span>
        <button @click="doRecordBaseline" :disabled="!canRecordBaseline"
          :title="baselineBlockReason || '把当前 commit + 产物 hash 固化为基线'"
          :style="{padding:'2px 8px',background:'#2d2d2d',color: canRecordBaseline ? '#ddd' : '#777',border:'1px solid #444',borderRadius:'4px',cursor: canRecordBaseline ? 'pointer' : 'not-allowed',fontSize:'11px'}">
          {{ syncBusy ? '处理中…' : '记录基线' }}
        </button>
        <button @click="doAnalyzeSync" :disabled="!canAnalyzeSync"
          :title="analyzeSyncBlockReason || '分析基线到当前 HEAD 的代码变更对产物的影响'"
          :style="{padding:'2px 8px',background:'#2d2d2d',color: canAnalyzeSync ? '#ddd' : '#777',border:'1px solid #444',borderRadius:'4px',cursor: canAnalyzeSync ? 'pointer' : 'not-allowed',fontSize:'11px'}">
          {{ syncBusy ? '处理中…' : '分析差异' }}
        </button>
      </div>
      <div v-if="syncStatus && (syncStatus.changed_artifacts.length || syncStatus.added_artifacts.length || syncStatus.removed_artifacts.length)"
        style="font-size:11px;color:#d29922;margin-bottom:2px;">
        产物变化：<span v-for="a in syncStatus.changed_artifacts" :key="'c'+a" style="margin-right:4px;">✎ {{ a }}</span>
        <span v-for="a in syncStatus.added_artifacts" :key="'a'+a" style="margin-right:4px;">＋ {{ a }}</span>
        <span v-for="a in syncStatus.removed_artifacts" :key="'r'+a" style="margin-right:4px;">－ {{ a }}</span>
      </div>
    </div>

    <!-- 消息/错误 -->
    <div v-if="message" style="padding:4px 10px;background:#1f3d2b;color:#3fb950;font-size:11px;flex-shrink:0;">{{ message }}</div>
    <div v-if="error" style="padding:4px 10px;background:#3d1f1f;color:#f85149;font-size:11px;flex-shrink:0;">{{ error }}</div>
    <!-- 帮助弹层 -->
    <div v-if="helpVisible" @click.self="helpVisible = false"
      style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;">
      <div style="background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:16px;max-width:420px;max-height:80%;overflow:auto;font-size:12px;color:#ddd;">
        <div style="font-weight:bold;font-size:13px;margin-bottom:8px;">🏭 黑灯工厂插件</div>
        <div style="line-height:1.6;">
          <p><b>用途</b>：对遗留项目执行规格逆向工程（Reversa），生成结构化 Markdown 规格（_reversa_sdd/），再基于 NLSpec 驱动黑灯工厂流水线正向开发，最后知识回流保持文档与代码同步，形成「逆向→正向→回流」闭环。</p>
          <p><b>使用步骤</b>：</p>
          <ol style="padding-left:18px;margin:4px 0;">
            <li>「① 项目」→ 添加项目目录（需为已存在目录）</li>
            <li>「② 逆向分析」→ 点「安装 Reversa」（Agent 也会自动装）</li>
            <li>「② 逆向分析」→ 可选：在 2.2 配置上游依赖、2.4 添加现存资料（逆向时会作为参考输入）</li>
            <li>「② 逆向分析」→ 点「🚀 开始逆向（新建 Agent）」开始逆向，等 5 阶段跑完</li>
            <li>「② 逆向分析」→ 浏览「规格产物」并「导出 Rules」</li>
            <li>「③ 正向开发」→ 新建/编辑 NLSpec（LLM 澄清四要素），一键「开启」跑黑灯工厂流水线</li>
            <li>「④ 知识回流」→ 记录基线、分析差异，保持文档与代码同步</li>
          </ol>
          <p><b>5 阶段</b>：侦察 → 挖掘 → 解读 → 生成 → 评审</p>
          <p><b>按钮可用性</b>：灰色按钮表示前置条件未满足，鼠标悬停可看原因。逆向需先安装 Reversa；导出 Rules 需有产物；知识回流需 git 仓库且已有基线；NLSpec 四要素不全时「开启」不可用（先点「编辑」澄清）。</p>
          <p><b>置信度</b>：🟢CONFIRMED 已确认 / 🟡INFERRED 推断 / 🔴GAP 缺口（默认不导出）</p>
          <p><b>数据</b>：设置存于浏览器 localStorage（按节点+项目隔离）；跨设备共享靠两台设备指向同一工作区目录。</p>
        </div>
        <div style="text-align:right;margin-top:10px;">
          <button @click="helpVisible = false"
            style="padding:5px 14px;background:#1f6feb;color:#fff;border:none;border-radius:4px;cursor:pointer;">关闭</button>
        </div>
      </div>
    </div>
  </div>
  `,
};
