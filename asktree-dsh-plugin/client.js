/**
 * asktree-dsh-plugin — Client 半（code.client）
 *
 * 来源：动态插件 askt-1 / pkg-6（Asktree v2：按会话隔离 + 重命名）
 * 用法：把整个函数体原样作为 cordis_define 的 code.client 传入。
 *
 * 职责：
 *  - shell.overlay 浮层：AskTree 完整交互画布（虚线连线、缩放/平移、折叠、
 *    拖拽、点选编辑、＋加子问题、重新回答、三种布局、Markdown 渲染）
 *  - conversation.session.header.actions：会话头「Asktree」开关按钮（按会话隔离）
 *  - 与 Host 树仓双向同步：host.call("asktree.getTree" / "asktree.mutate")
 *
 * 说明：Client 环境无 document/window 全局，全部 UI 用 React.createElement 构建。
 */
return {
  apply(ctx) {
    const h = React.createElement;

    /* ================= 共享 UI 状态（插件生命周期内存） ================= */
    const ui = {
      sessionId: null,          // 当前会话 id（由会话头按钮捕获）
      open: false,
      snapshot: null,           // { tree, title, via, notice }
      layout: "h",              // h | v | free
      zoom: 1,
      selectedId: null,
      positions: {},            // id -> {x,y}（自由拖拽）
      collapsed: {},            // id -> bool
      ansShown: {},             // id -> bool（块内显示回答）
      loading: {},              // id -> bool（回答生成中）
      busy: false,              // 全局处理中
      autoAnswer: true,         // 添加子问题后自动回答
      addBoxFor: null,          // 正在输入子问题的节点
      msg: null
    };
    let version = 0;
    const listeners = new Set();
    function bump() { version++; listeners.forEach(fn => fn()); }
    function useVersion() {
      const [v, setV] = React.useState(0);
      React.useEffect(() => {
        const fn = () => setV(version);
        listeners.add(fn);
        return () => listeners.delete(fn);
      }, []);
      return v;
    }
    function setMsg(text) {
      ui.msg = text || null;
      bump();
      if (text) {
        const timer = ctx.get("timer");
        if (timer) timer.timeout(() => { if (ui.msg === text) { ui.msg = null; bump(); } }, 3500);
      }
    }

    /* ================= Host RPC（按会话） ================= */
    async function getTree() {
      try { return await host.call("asktree.getTree", { sessionId: ui.sessionId || null }); } catch (e) { console.error(e); return null; }
    }
    async function mutate(args) {
      try { return await host.call("asktree.mutate", { ...args, sessionId: ui.sessionId || null }); } catch (e) {
        return { ok: false, reason: e && e.message ? String(e.message) : String(e) };
      }
    }
    function applySnapshot(res) {
      if (res && res.ok !== false && res.tree) {
        ui.snapshot = { tree: res.tree, title: res.title || null, via: res.via || null, notice: res.notice || null };
        pruneLocal();
      }
    }
    function pruneLocal() {
      const ids = new Set(Object.keys((ui.snapshot && ui.snapshot.tree && ui.snapshot.tree.nodes) || {}));
      Object.keys(ui.positions).forEach(k => { if (!ids.has(k)) delete ui.positions[k]; });
      Object.keys(ui.collapsed).forEach(k => { if (!ids.has(k)) delete ui.collapsed[k]; });
      Object.keys(ui.ansShown).forEach(k => { if (!ids.has(k)) delete ui.ansShown[k]; });
      Object.keys(ui.loading).forEach(k => { if (!ids.has(k)) delete ui.loading[k]; });
      if (ui.selectedId && !ids.has(ui.selectedId)) ui.selectedId = null;
    }
    async function refresh() {
      const snap = await getTree();
      if (!snap || !snap.tree) return;
      const key = JSON.stringify(snap);
      const old = ui.snapshot ? JSON.stringify(ui.snapshot) : "";
      if (key !== old) { ui.snapshot = snap; pruneLocal(); bump(); }
    }

    /* ================= 布局（AskTree 移植，估算高度） ================= */
    const PAD = 60, BW = 300, HGAP = 64, VGAP = 26;
    function estQ(text) { return Math.max(1, Math.ceil(String(text || "").length / 26)) * 20 + 14; }
    function estA(text) { return Math.min(6, Math.max(1, Math.ceil(String(text || "").length / 36))) * 18 + 10; }
    function nodeHeight(n) {
      let hh = 42 + estQ(n.text) + 26;
      if (ui.ansShown[n.id] && (n.answer || "").trim()) hh += 26 + estA(n.answer);
      hh += 44;
      return hh;
    }
    function computeLabels(tree) {
      const labels = {};
      let i = 0;
      (function walk(id) {
        const n = tree.nodes[id]; if (!n) return;
        labels[id] = "Q" + (++i);
        (n.children || []).forEach(walk);
      })(tree.rootId);
      return labels;
    }
    function computeLayout(tree) {
      const labels = computeLabels(tree);
      const pos = {};
      const visibleKids = id => {
        const n = tree.nodes[id];
        return (n.children || []).filter(c => tree.nodes[c] && !ui.collapsed[id]);
      };
      const height = id => {
        const n = tree.nodes[id]; if (!n) return 0;
        const self = nodeHeight(n);
        const kids = visibleKids(id);
        if (!kids.length) return self;
        let sum = 0; kids.forEach(k => sum += height(k));
        return Math.max(self, sum + (kids.length - 1) * VGAP);
      };
      const width = id => {
        const n = tree.nodes[id]; if (!n) return 0;
        const kids = visibleKids(id);
        if (!kids.length) return BW;
        let sum = 0; kids.forEach(k => sum += width(k));
        return Math.max(BW, sum + (kids.length - 1) * HGAP);
      };
      const placeH = (id, x, y, totalH) => {
        const n = tree.nodes[id]; if (!n) return;
        const self = nodeHeight(n);
        let px = x, py = y;
        if (ui.positions[id]) { px = ui.positions[id].x; py = ui.positions[id].y; }
        else py = y + (totalH - self) / 2;
        pos[id] = { x: px, y: py };
        const kids = visibleKids(id);
        let childSum = 0; kids.forEach(k => childSum += height(k));
        const childTop = py + Math.max(0, (self - childSum) / 2);
        let yy = childTop;
        kids.forEach(k => { const hh = height(k); placeH(k, px + BW + HGAP, yy, hh); yy += hh + VGAP; });
      };
      const placeV = (id, y, x, totalW) => {
        const n = tree.nodes[id]; if (!n) return;
        const self = nodeHeight(n);
        let px = x, py = y;
        if (ui.positions[id]) { px = ui.positions[id].x; py = ui.positions[id].y; }
        else px = x + (totalW - BW) / 2;
        pos[id] = { x: px, y: py };
        const kids = visibleKids(id);
        let childSum = 0; kids.forEach(k => childSum += width(k));
        const childLeft = px + Math.max(0, (BW - childSum) / 2);
        let xx = childLeft;
        kids.forEach(k => { const w = width(k); placeV(k, py + self + VGAP, xx, w); xx += w + HGAP; });
      };
      if (tree.rootId && tree.nodes[tree.rootId]) {
        if (ui.layout === "v") placeV(tree.rootId, PAD, PAD, width(tree.rootId));
        else placeH(tree.rootId, PAD, PAD, height(tree.rootId));
      }
      return { pos, labels };
    }

    /* ================= Markdown（AskTree 移植） ================= */
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function inlineMd(raw) {
      let t = esc(raw);
      const codes = [];
      t = t.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => {
        const ok = /^(https?:|mailto:)/i.test(url);
        return '<a href="' + (ok ? url : "#") + '" target="_blank" rel="noopener noreferrer">' + txt + "</a>";
      });
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
      t = t.replace(/(^|[^a-zA-Z0-9_])_([^_]+)_/g, "$1<em>$2</em>");
      t = t.replace(/\u0000(\d+)\u0000/g, (m, idx) => '<code class="at-icode">' + codes[+idx] + "</code>");
      return t;
    }
    function mdToHtml(src) {
      if (!src) return "";
      const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
      let html = "", i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const fence = line.match(/^```(\w*)\s*$/);
        if (fence) {
          const buf = [];
          i++;
          while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
          i++;
          html += '<pre class="at-code"><code>' + esc(buf.join("\n")) + "</code></pre>";
          continue;
        }
        if (/^\s*$/.test(line)) { i++; continue; }
        const hd = line.match(/^(#{1,6})\s+(.*)$/);
        if (hd) { const lvl = hd[1].length; html += "<h" + lvl + ' class="at-h at-h' + lvl + '">' + inlineMd(hd[2]) + "</h" + lvl + ">"; i++; continue; }
        if (/^>\s?/.test(line)) {
          const buf = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
          html += '<blockquote class="at-quote">' + inlineMd(buf.join(" ")) + "</blockquote>";
          continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
          html += '<ul class="at-ul">' + items.map(it => "<li>" + inlineMd(it) + "</li>").join("") + "</ul>";
          continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          const items = [];
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
          html += '<ol class="at-ol">' + items.map(it => "<li>" + inlineMd(it) + "</li>").join("") + "</ol>";
          continue;
        }
        const buf = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^```/.test(lines[i])) {
          buf.push(lines[i]); i++;
        }
        html += '<p class="at-p">' + buf.map(l => inlineMd(l)).join("<br>") + "</p>";
      }
      return html;
    }
    const md = src => mdToHtml(src);

    /* ================= 交互 ================= */
    const drag = { mode: null, id: null, sx: 0, sy: 0, moved: false, justDragged: false };
    const bodyRef = { current: null };
    function select(id) { ui.selectedId = id; bump(); }
    function setLayout(mode) {
      ui.layout = mode;
      if (mode !== "free") ui.positions = {};
      bump();
    }
    function fitView() {
      const el = bodyRef.current;
      if (!el || !ui.snapshot) return;
      const { pos } = computeLayout(ui.snapshot.tree);
      let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
      Object.keys(pos).forEach(id => {
        const n = ui.snapshot.tree.nodes[id];
        minX = Math.min(minX, pos[id].x); minY = Math.min(minY, pos[id].y);
        maxX = Math.max(maxX, pos[id].x + BW); maxY = Math.max(maxY, pos[id].y + nodeHeight(n));
      });
      if (!isFinite(minX)) return;
      const cw = maxX - minX + 120, ch = maxY - minY + 120;
      const availW = el.clientWidth - 80, availH = el.clientHeight - 80;
      if (availW <= 0 || availH <= 0) return;
      ui.zoom = Math.max(0.15, Math.min(1, Math.min(availW / cw, availH / ch)));
      bump();
    }
    async function reanswer(id) {
      if (ui.loading[id]) return;
      ui.loading[id] = true; ui.busy = true; bump();
      const res = await mutate({ op: "answer", nodeId: id });
      ui.loading[id] = false; ui.busy = false;
      if (res && res.ok === false) setMsg(res.reason || "重新回答失败");
      else applySnapshot(res);
      bump();
    }
    async function removeNode(id) {
      if (!ui.confirmDelete) {
        ui.confirmDelete = id;
        setMsg("再次点击「删除」确认删除该节点及其子树");
        bump();
        const timer = ctx.get("timer");
        if (timer) timer.timeout(() => { if (ui.confirmDelete === id) { ui.confirmDelete = null; bump(); } }, 4000);
        return;
      }
      ui.confirmDelete = null;
      ui.busy = true; bump();
      const res = await mutate({ op: "remove", nodeId: id });
      ui.busy = false;
      if (res && res.ok === false) setMsg(res.reason || "删除失败");
      else { applySnapshot(res); if (ui.selectedId === id) ui.selectedId = null; }
      bump();
    }
    async function addChild(parentId, text) {
      ui.busy = true; ui.addBoxFor = null; bump();
      const res = await mutate({ op: "addChild", parentId, text, autoAnswer: ui.autoAnswer });
      ui.busy = false;
      if (res && res.ok === false) setMsg(res.reason || "添加失败");
      else applySnapshot(res);
      bump();
    }
    async function saveNode(id, text, answer) {
      ui.busy = true; bump();
      const res = await mutate({ op: "save", nodeId: id, text, answer });
      ui.busy = false;
      if (res && res.ok === false) setMsg(res.reason || "保存失败");
      else applySnapshot(res);
      bump();
    }
    async function loadDemo() {
      ui.busy = true; bump();
      const res = await mutate({ op: "demo" });
      ui.busy = false;
      if (res && res.ok === false) setMsg(res.reason || "载入失败");
      else applySnapshot(res);
      bump();
    }

    /* ================= 组件 ================= */
    function OverlayEntry() {
      useVersion();
      if (!ui.open) return null;
      return h(Panel, {});
    }
    function HeaderAction(props) {
      useVersion();
      React.useEffect(() => {
        if (props && props.sessionId && props.sessionId !== ui.sessionId) {
          ui.sessionId = props.sessionId;
          refresh();
        }
      }, [props && props.sessionId]);
      const count = ui.snapshot && ui.snapshot.tree ? Object.keys(ui.snapshot.tree.nodes).length : 0;
      return h("button", {
        className: "at-toggle" + (ui.open ? " at-on" : ""),
        title: "Asktree 问答树画布" + (count ? "（" + count + " 个节点）" : ""),
        onClick: () => { ui.open = !ui.open; if (ui.open) refresh(); bump(); }
      }, "Asktree");
    }
    function Panel() {
      useVersion();
      React.useEffect(() => {
        refresh();
        const timer = ctx.get("timer");
        if (!timer) return;
        const dispose = timer.interval(() => { if (ui.open) refresh(); }, 1500);
        return dispose;
      }, []);
      const tree = ui.snapshot && ui.snapshot.tree ? ui.snapshot.tree : null;
      const title = (ui.snapshot && ui.snapshot.title) || "问答树";
      const via = ui.snapshot ? ui.snapshot.via : null;
      const count = tree ? Object.keys(tree.nodes).length : 0;
      return h("div", { className: "at-panel" },
        h("div", { className: "at-head" },
          h("span", { className: "at-title" }, "Asktree · " + title),
          via && h("span", { className: "at-badge via" }, via),
          h("span", { className: "at-count" }, count + " 节点"),
          ui.busy && h("span", { className: "at-spinner-wrap" }, h("span", { className: "at-spinner" }), " 处理中…"),
          h("div", { className: "at-head-spacer" }),
          h("button", { className: "at-hbtn", title: "重新从宿主同步", onClick: () => refresh() }, "⟳"),
          h("button", { className: "at-hbtn" + (ui.layout === "h" ? " at-on" : ""), onClick: () => setLayout("h") }, "水平"),
          h("button", { className: "at-hbtn" + (ui.layout === "v" ? " at-on" : ""), onClick: () => setLayout("v") }, "垂直"),
          h("button", { className: "at-hbtn" + (ui.layout === "free" ? " at-on" : ""), onClick: () => setLayout("free") }, "自由"),
          h("button", { className: "at-hbtn" + (ui.autoAnswer ? " at-on" : ""), title: "添加子问题后是否自动回答", onClick: () => { ui.autoAnswer = !ui.autoAnswer; bump(); } }, ui.autoAnswer ? "自动回答" : "手动回答"),
          h("button", { className: "at-hbtn", onClick: fitView }, "适配"),
          h("button", { className: "at-hbtn at-close", title: "关闭", onClick: () => { ui.open = false; bump(); } }, "✕")
        ),
        ui.msg && h("div", { className: "at-msg" }, ui.msg),
        tree ? h(TreeBody, { tree }) : h("div", { className: "at-empty" },
          h("p", null, "还没有问答树。让模型运行 asktree_import_share / asktree_parse_chat / asktree_show，或先载入一棵示例树。"),
          h("button", { className: "at-go", onClick: loadDemo }, "载入示例树")
        )
      );
    }
    function TreeBody({ tree }) {
      useVersion();
      const { pos, labels } = computeLayout(tree);
      let minX = 0, minY = 0, maxX = BW, maxY = 100;
      Object.keys(pos).forEach(id => {
        const n = tree.nodes[id];
        minX = Math.min(minX, pos[id].x); minY = Math.min(minY, pos[id].y);
        maxX = Math.max(maxX, pos[id].x + BW); maxY = Math.max(maxY, pos[id].y + nodeHeight(n));
      });
      const pad = 120, x0 = Math.min(minX, 0), y0 = Math.min(minY, 0);
      const cw = maxX - x0 + pad, ch = maxY - y0 + pad;
      const links = [];
      Object.keys(tree.nodes).forEach(id => {
        const n = tree.nodes[id];
        if (ui.collapsed[id] || !n.children) return;
        n.children.forEach(cid => {
          if (!tree.nodes[cid] || !pos[id] || !pos[cid] || ui.collapsed[cid]) return;
          const pa = pos[id], chp = pos[cid];
          const mode = ui.layout === "free"
            ? (Math.abs(chp.x - pa.x) >= Math.abs(chp.y - pa.y) ? "h" : "v")
            : ui.layout;
          let d;
          if (mode === "v") {
            const x1 = pa.x + BW / 2, y1 = pa.y + nodeHeight(n);
            const x2 = chp.x + BW / 2, y2 = chp.y;
            const my = (y1 + y2) / 2;
            d = "M " + x1 + " " + y1 + " C " + x1 + " " + my + ", " + x2 + " " + my + ", " + x2 + " " + y2;
          } else {
            const x1 = pa.x + BW, y1 = pa.y + nodeHeight(n) / 2;
            const x2 = chp.x, y2 = chp.y + nodeHeight(tree.nodes[cid]) / 2;
            const mx = (x1 + x2) / 2;
            d = "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2;
          }
          links.push(h("path", { key: id + ">" + cid, d, className: "at-link" }));
        });
      });
      const blocks = [];
      (function walk(id) {
        const n = tree.nodes[id]; if (!n) return;
        blocks.push(h(Block, { key: id, node: n, pos: pos[id], label: labels[id] }));
        if (!ui.collapsed[id]) (n.children || []).forEach(walk);
      })(tree.rootId);
      return h("div", {
        className: "at-body",
        ref: el => { bodyRef.current = el; },
        onWheel: e => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          ui.zoom = Math.min(2, Math.max(0.15, ui.zoom * f));
          bump();
        },
        onPointerDown: e => {
          if (e.target.closest(".at-block")) return;
          drag.mode = "pan"; drag.sx = e.clientX; drag.sy = e.clientY;
        },
        onPointerMove: e => {
          if (drag.mode === "pan") {
            const el = bodyRef.current;
            if (el) { el.scrollLeft -= (e.clientX - drag.sx); el.scrollTop -= (e.clientY - drag.sy); drag.sx = e.clientX; drag.sy = e.clientY; }
          } else if (drag.mode === "block" && drag.id) {
            const el = bodyRef.current;
            if (!el) return;
            if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
            const rect = el.getBoundingClientRect();
            const x = (e.clientX - rect.left) / ui.zoom;
            const y = (e.clientY - rect.top) / ui.zoom;
            ui.positions[drag.id] = { x, y };
            bump();
          }
        },
        onPointerUp: () => {
          if (drag.mode === "block" && drag.moved) drag.justDragged = true;
          drag.mode = null; drag.id = null; drag.moved = false;
        },
        onDoubleClick: e => {
          if (e.target.closest(".at-block")) return;
          ui.zoom = 1; bump();
        }
      },
        h("div", { className: "at-tinner", style: { transform: "scale(" + ui.zoom + ")", transformOrigin: "0 0" } },
          h("div", { className: "at-canvas", style: { width: cw + "px", height: ch + "px", transform: "translate(" + (-x0) + "px," + (-y0) + "px)" } },
            h("svg", { className: "at-links", width: cw, height: ch }, links),
            blocks
          )
        ),
        ui.selectedId && h(Inspector, { tree })
      );
    }
    function Block({ node, pos, label }) {
      const id = node.id;
      const selected = ui.selectedId === id;
      const collapsed = !!ui.collapsed[id];
      const showAns = !!ui.ansShown[id];
      const loading = !!ui.loading[id];
      const kids = (node.children || []).filter(c => ui.snapshot && ui.snapshot.tree.nodes[c]).length;
      const onPointerDown = e => {
        if (e.target.closest("button,textarea,input")) return;
        e.preventDefault();
        drag.mode = "block"; drag.id = id; drag.sx = e.clientX; drag.sy = e.clientY; drag.moved = false;
        try { e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
      };
      return h("div", {
        className: "at-block" + (selected ? " at-selected" : "") + (collapsed ? " at-collapsed" : ""),
        style: { left: pos.x + "px", top: pos.y + "px" },
        onPointerDown: onPointerDown,
        onClick: e => {
          if (drag.justDragged) { drag.justDragged = false; return; }
          if (e.target.closest("button,textarea,input")) return;
          select(id);
        }
      },
        h("div", { className: "at-block-head" },
          h("button", {
            className: "at-chev" + (collapsed ? "" : " at-rot"),
            title: collapsed ? "展开" : "折叠",
            disabled: !kids,
            onClick: e => { e.stopPropagation(); ui.collapsed[id] = !ui.collapsed[id]; bump(); }
          }, "▸"),
          h("span", { className: "at-badge" }, label + (kids ? " " + kids : "")),
          h("span", { className: "at-grip", title: "按住拖动" }, "⠿")
        ),
        h("div", { className: "at-q" }, node.text || "（空）"),
        h("div", { className: "at-meta", onClick: e => { e.stopPropagation(); select(id); } },
          loading ? h("span", { className: "at-spinner" }) :
            ((node.answer || "").trim() ? h("span", { className: "at-dot at-ok" }) : h("span", { className: "at-dot" })),
          loading ? " AI 正在回答…" : ((node.answer || "").trim() ? " 已回答 · 点击查看" : " 未回答")
        ),
        showAns && (loading || (node.answer || "").trim()) && h("div", { className: "at-ans" },
          loading ? h("span", { className: "at-spinner" }, " AI 正在回答…") : h("div", { className: "at-md", dangerouslySetInnerHTML: { __html: md(node.answer) } })
        ),
        collapsed && kids > 0 && h("div", { className: "at-note" }, "已折叠 " + kids + " 个子问题"),
        ui.addBoxFor === id && h(AddBox, { parentId: id }),
        h("div", { className: "at-actions" },
          h("button", { className: "at-cbtn at-go", title: "基于祖先链上下文重新生成回答", onClick: e => { e.stopPropagation(); reanswer(id); } }, "⟳ 重新回答"),
          h("button", { className: "at-cbtn", onClick: e => { e.stopPropagation(); ui.ansShown[id] = !showAns; bump(); } }, showAns ? "隐藏回答" : "显示回答"),
          h("button", { className: "at-cbtn at-danger", title: "删除该节点及以下所有内容", onClick: e => { e.stopPropagation(); removeNode(id); } }, "删除")
        ),
        h("button", { className: "at-add", title: "添加子问题", onClick: e => { e.stopPropagation(); ui.addBoxFor = ui.addBoxFor === id ? null : id; bump(); } }, "+")
      );
    }
    function AddBox({ parentId }) {
      const [text, setText] = React.useState("");
      const submit = () => { const v = text.trim(); if (v) addChild(parentId, v); };
      return h("div", { className: "at-addbox", onClick: e => e.stopPropagation() },
        h("textarea", {
          className: "at-ta", placeholder: "输入一个子问题…", value: text,
          onChange: e => setText(e.target.value),
          onKeyDown: e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }
        }),
        h("div", { className: "at-addbox-row" },
          h("button", { className: "at-cbtn", onClick: () => { ui.addBoxFor = null; bump(); } }, "取消"),
          h("button", { className: "at-cbtn at-go", onClick: submit }, "添加" + (ui.autoAnswer ? "并回答" : ""))
        )
      );
    }
    function Inspector({ tree }) {
      useVersion();
      const id = ui.selectedId;
      const node = id && tree.nodes[id] ? tree.nodes[id] : null;
      if (!node) return null;
      return h(InspectorInner, { key: id, node });
    }
    function InspectorInner({ node }) {
      const id = node.id;
      const [q, setQ] = React.useState(node.text || "");
      const [a, setA] = React.useState(node.answer || "");
      return h("div", { className: "at-inspector" },
        h("div", { className: "at-insp-head" },
          h("span", { className: "at-badge" }, "Q · " + id),
          h("span", { className: "at-insp-path" },
            (function path() {
              const chain = [];
              let cur = node;
              const nodes = ui.snapshot.tree.nodes;
              while (cur) { chain.unshift(cur); cur = cur.parentId ? nodes[cur.parentId] : null; }
              return chain.map((p, i) => h("span", { key: p.id }, (i ? " → " : "") + (p.text || "").slice(0, 18)));
            })()
          ),
          h("div", { className: "at-head-spacer" }),
          h("button", { className: "at-cbtn at-danger", onClick: () => { removeNode(id); ui.selectedId = null; bump(); } }, "删除子树"),
          h("button", { className: "at-cbtn", onClick: () => { ui.addBoxFor = id; bump(); } }, "添加子问题"),
          h("button", { className: "at-cbtn at-go", onClick: () => { ui.loading[id] = true; bump(); reanswer(id); } }, "重新回答"),
          h("button", { className: "at-cbtn at-go", onClick: () => saveNode(id, q, a) }, "保存修改")
        ),
        h("div", { className: "at-insp-grid" },
          h("div", { className: "at-insp-col" },
            h("div", { className: "at-label" }, "问题（可编辑）"),
            h("textarea", { className: "at-ta", value: q, onChange: e => setQ(e.target.value) }),
            h("div", { className: "at-label" }, "回答（可编辑）"),
            h("textarea", { className: "at-ta at-ta-ans", value: a, onChange: e => setA(e.target.value) })
          ),
          h("div", { className: "at-insp-col" },
            h("div", { className: "at-label" }, "Markdown 预览"),
            h("div", { className: "at-md at-preview", dangerouslySetInnerHTML: { __html: md(a) } })
          )
        )
      );
    }

    /* ================= 注册 ================= */
    const css = `
.at-toggle{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;font-size:12.5px;color:#a8b0c0;background:transparent;border:1px solid transparent;cursor:pointer;white-space:nowrap}
.at-toggle:hover{background:#222735;color:#e8ebf2}
.at-toggle.at-on{background:#1e4d86;color:#cfe3fb;border-color:#2f6cb3}
.at-panel{position:fixed;top:56px;left:16px;right:16px;bottom:16px;max-width:1180px;margin:0 auto;display:flex;flex-direction:column;background:#15181f;border:1px solid #2a3040;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:1000;overflow:hidden;pointer-events:auto;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,sans-serif;font-size:13px;color:#e8ebf2}
.at-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #2a3040;background:#1b1f28;flex-wrap:wrap}
.at-title{font-size:13.5px;font-weight:600;color:#e8ebf2}
.at-count{font-size:11.5px;color:#6d7688}
.at-badge{font-size:11px;font-weight:600;padding:1px 7px;border-radius:5px;background:#0b2748;color:#c3dcf7;border:1px solid #2f6cb3}
.at-badge.via{background:#123324;color:#9fe0bd;border-color:#4caf7d}
.at-head-spacer{flex:1}
.at-hbtn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:7px;font-size:12px;color:#a8b0c0;background:transparent;border:1px solid transparent;cursor:pointer}
.at-hbtn:hover{background:#222735;color:#e8ebf2}
.at-hbtn.at-on{background:#1e4d86;color:#cfe3fb;border-color:#2f6cb3}
.at-hbtn.at-close:hover{color:#e0695f}
.at-spinner-wrap{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:#6d7688}
.at-msg{position:absolute;top:52px;left:50%;transform:translateX(-50%);background:#222735;border:1px solid #39415a;color:#e8ebf2;padding:6px 16px;border-radius:8px;font-size:12px;z-index:10}
.at-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a8b0c0;font-size:12.5px;text-align:center;padding:20px}
.at-go{background:#123324;color:#8fd8b2;border:1px solid #4caf7d;padding:7px 20px;border-radius:8px;font-size:12.5px;cursor:pointer}
.at-go:hover{background:#1a4a33;color:#b7e9cd}
.at-body{flex:1;overflow:auto;position:relative;background-color:#0e1014;background-image:linear-gradient(rgba(148,163,184,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.08) 1px,transparent 1px);background-size:26px 26px;background-attachment:local;cursor:grab}
.at-tinner{transform-origin:0 0;width:max-content;position:relative}
.at-canvas{position:relative}
.at-links{position:absolute;inset:0;pointer-events:none;overflow:visible}
.at-link{fill:none;stroke:rgba(148,163,184,.55);stroke-width:1.6;stroke-dasharray:7 5}
.at-block{position:absolute;width:300px;background:#1b1f28;border:1px solid #39415a;border-radius:10px;padding:9px 11px 8px;cursor:grab;user-select:none;touch-action:none;box-shadow:0 2px 10px rgba(0,0,0,.3)}
.at-block:hover{border-color:#4a5570}
.at-block.at-selected{border-color:#4d8fe0;box-shadow:0 0 0 1.5px #4d8fe0,0 4px 18px rgba(77,143,224,.22)}
.at-block-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.at-chev{width:17px;height:17px;flex:0 0 17px;display:flex;align-items:center;justify-content:center;color:#6d7688;background:none;border:none;border-radius:4px;cursor:pointer;font-size:11px;transition:transform .15s}
.at-chev:hover{color:#e8ebf2;background:#222735}
.at-chev.at-rot{transform:rotate(90deg)}
.at-chev:disabled{visibility:hidden}
.at-grip{color:#6d7688;margin-left:auto;cursor:grab;opacity:.6;font-size:13px}
.at-q{font-size:13px;color:#e8ebf2;line-height:1.55;padding:6px 9px;background:#0b2748;border:1px solid #2f6cb3;border-radius:8px;margin-bottom:6px;white-space:pre-wrap;word-break:break-word}
.at-meta{display:flex;align-items:center;gap:5px;font-size:11px;color:#6d7688;padding:2px 4px;border-radius:6px;cursor:pointer}
.at-meta:hover{color:#a8b0c0;background:#222735}
.at-dot{width:6px;height:6px;border-radius:50%;flex:0 0 6px;background:#6d7688}
.at-dot.at-ok{background:#4caf7d}
.at-note{font-size:10.5px;color:#6d7688;margin-top:4px}
.at-ans{margin-top:6px;max-height:220px;overflow:auto}
.at-actions{display:flex;gap:4px;margin-top:7px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.1);opacity:.35;transition:opacity .12s}
.at-block:hover .at-actions,.at-block.at-selected .at-actions{opacity:1}
.at-cbtn{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;font-size:11.5px;color:#a8b0c0;background:none;border:1px solid #39415a;cursor:pointer}
.at-cbtn:hover{background:#222735;color:#e8ebf2}
.at-cbtn.at-go{color:#4caf7d}
.at-cbtn.at-go:hover{background:#123324;color:#9fe0bd;border-color:#4caf7d}
.at-cbtn.at-danger:hover{color:#e0695f;border-color:#e0695f}
.at-add{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;margin:7px auto 1px;background:#222735;border:1px solid #4caf7d;color:#4caf7d;font-size:15px;cursor:pointer;transition:transform .12s}
.at-add:hover{background:#123324;color:#9fe0bd;transform:scale(1.1)}
.at-addbox{display:flex;flex-direction:column;gap:6px;margin-top:7px;background:#15181f;border:1px solid #2f6cb3;border-radius:8px;padding:8px}
.at-addbox-row{display:flex;gap:6px;justify-content:flex-end}
.at-ta{width:100%;background:#15181f;border:1px solid #2a3040;border-radius:7px;padding:7px 9px;font-size:12.5px;color:#e8ebf2;resize:vertical;outline:none;font-family:inherit;line-height:1.6;min-height:38px}
.at-ta:focus{border-color:#2f6cb3}
.at-ta-ans{min-height:120px}
.at-inspector{border-top:1px solid #2a3040;background:#1b1f28;padding:10px 14px 12px}
.at-insp-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.at-insp-path{font-size:11px;color:#6d7688;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.at-insp-grid{display:flex;gap:12px}
.at-insp-col{flex:1;min-width:0}
.at-label{font-size:11px;color:#6d7688;margin:6px 0 4px;letter-spacing:.4px}
.at-preview{max-height:180px;overflow:auto;background:#15181f;border:1px solid #2a3040;border-radius:8px;padding:8px 10px}
.at-md{font-size:12.5px;line-height:1.7;color:#e8ebf2;word-break:break-word}
.at-md .at-h{margin:.5em 0 .3em;font-weight:700}
.at-md .at-h1{font-size:1.35em}.at-md .at-h2{font-size:1.22em}.at-md .at-h3{font-size:1.1em}.at-md .at-h4,.at-md .at-h5,.at-md .at-h6{font-size:1em}
.at-md .at-p{margin:.35em 0}
.at-md .at-ul,.at-md .at-ol{margin:.35em 0;padding-left:1.35em}
.at-md .at-ul{list-style:disc}.at-md .at-ol{list-style:decimal}
.at-md .at-icode{background:#222735;border:1px solid #2a3040;border-radius:4px;padding:0 5px;font-family:ui-monospace,Consolas,monospace;font-size:.9em}
.at-md .at-code{background:#222735;border:1px solid #2a3040;border-radius:8px;padding:9px 11px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;margin:.45em 0}
.at-md .at-quote{margin:.45em 0;padding:.35em 11px;border-left:3px solid #2f6cb3;color:#a8b0c0;background:#222735;border-radius:0 8px 8px 0}
.at-md a{color:#c3dcf7;text-decoration:underline}
.at-md strong{color:#e8ebf2}
.at-spinner{width:12px;height:12px;border-radius:50%;border:2px solid #2a3040;border-top-color:#4d8fe0;display:inline-block;animation:at-spin .8s linear infinite}
@keyframes at-spin{to{transform:rotate(360deg)}}
`;
    styles.insert(css);

    const slots = ctx.get("slots");
    if (slots === undefined) return;
    slots.inject("shell.overlay", () => slots.register(
      { name: "shell.overlay", id: "asktree-canvas", order: 30 },
      () => h(OverlayEntry, {})
    ));
    slots.inject("conversation.session.header.actions", () => slots.register(
      { name: "conversation.session.header.actions", id: "asktree-toggle", order: 15 },
      (props) => h(HeaderAction, props)
    ));
  }
};
