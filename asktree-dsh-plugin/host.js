/**
 * asktree-dsh-plugin — Host 半（code.host）
 *
 * 来源：动态插件 askt-1 / pkg-5（AskTree 可视化 v1）
 * 用法：把整个函数体原样作为 cordis_define 的 code.host 传入。
 *
 * 职责：
 *  - 5 个模型工具：asktree_import_share / asktree_parse_chat / asktree_show /
 *    asktree_build_context / asktree_answer
 *  - 内存树仓 + GUI 画布 RPC：harness.handle("asktree.getTree" / "asktree.mutate")
 *
 * 说明：本文件是「函数体」，不是可独立运行的 Node 模块；
 * 动态插件由 DSH 会话的 cordis_define 加载（详见 README.md）。
 */
return {
  apply(ctx) {
    /* ============ AskTree 移植：常量与纯函数 ============ */
    const AI_END_RE = /本回答由 AI 生成|内容仅供参考，请仔细甄别|由 AI 生成，仅供参考/;
    const Q_SPEECH_RE = /^(ok|好的|嗯|好|这样|我|感谢|谢谢|明白了|原来|但是|不过|那|那么|所以|能否|能|请|帮忙|可以|老师|您好|hi|hello)/i;
    const SYSTEM_PROMPT =
      "你是一个严谨的助手。用户正在用「树形问答」逐层深入一个主题：" +
      "同一层会出现多个并列的追问，请针对当前问题作答，不要重复其他分支的内容；" +
      "回答要具体、可操作，避免空泛。若上下文不足，可指出需要补充的信息。";

    /* ---- 树仓（供 GUI 画布读取/修改；插件生命周期内存） ---- */
    const store = { tree: null, title: null, via: null, notice: null };
    function setStore(tree, title, via, notice) { store.tree = tree; store.title = title || null; store.via = via || null; store.notice = notice || null; }
    function snapshot() { return { tree: store.tree, title: store.title, via: store.via, notice: store.notice }; }
    function nextNodeId(tree) {
      let m = 0;
      Object.keys(tree.nodes || {}).forEach(k => {
        const n = parseInt(String(k).replace(/\D/g, ""), 10);
        if (Number.isFinite(n) && n > m) m = n;
      });
      return "n" + (m + 1);
    }
    function removeSubtree(tree, id) {
      const n = tree.nodes[id]; if (!n) return;
      (n.children || []).forEach(c => removeSubtree(tree, c));
      delete tree.nodes[id];
      if (n.parentId) { const p = tree.nodes[n.parentId]; if (p) p.children = (p.children || []).filter(c => c !== id); }
      else if (tree.rootId === id) tree.rootId = null;
    }
    function requireNode(id) {
      const n = store.tree && store.tree.nodes && store.tree.nodes[id];
      if (!n) throw new Error("节点 " + id + " 不存在于当前树");
      return n;
    }
    async function answerNode(nodeId) {
      const n = requireNode(nodeId);
      const context = buildContext(store.tree, nodeId);
      const route = await resolveRoute(ctx, null, null);
      const r = await streamAnswer(route, context.messages, context.system, 0.6, 900, undefined);
      n.answer = r.text;
      return r;
    }
    const DEMO_TREE = { nodes: {
      n1: { id: "n1", text: "深度学习在量化投资中到底能用在哪些环节？", answer: "主要四类：1）信号生成与因子挖掘；2）组合构建；3）执行与成本建模；4）另类数据理解。落地最成熟的是信号/因子这一环。", parentId: null, children: ["n2", "n3"] },
      n2: { id: "n2", text: "用深度学习做因子挖掘，输入特征一般怎么构造？", answer: "时序特征、截面特征、基本面/另类三线；注意时间对齐与标签泄漏两个坑。", parentId: "n1", children: [] },
      n3: { id: "n3", text: "这类模型实盘最大的坑是什么？", answer: "未来函数、过拟合、高换手被成本吃掉、因子拥挤与衰减。", parentId: "n1", children: [] }
    }, rootId: "n1" };

    /* ---- 分享消息 → 问答树（AskTree buildTreeFromMessages 移植）---- */
    function buildTreeFromMessages(messages) {
      const byId = {};
      messages.forEach(m => { byId[m.message_id] = m; });
      const userMsgs = messages.filter(m => m.role === "USER");
      const nodes = {};
      const nodeByMsg = {};
      let nextId = 1;
      let rootId = null;
      let rootCount = 0;
      const warnings = [];
      userMsgs.forEach(m => {
        let parentQMsg = null;
        if (m.parent_id != null && byId[m.parent_id]) {
          const p = byId[m.parent_id];
          if (p.role === "USER") parentQMsg = p.message_id;
          else if (p.parent_id != null && byId[p.parent_id] && byId[p.parent_id].role === "USER") parentQMsg = byId[p.parent_id].message_id;
        }
        const id = "n" + (nextId++);
        const parentNodeId = parentQMsg != null ? nodeByMsg[parentQMsg] : null;
        nodes[id] = { id, text: m.content || "（空问题）", answer: "", parentId: parentNodeId, children: [] };
        if (parentNodeId && nodes[parentNodeId]) nodes[parentNodeId].children.push(id);
        nodeByMsg[m.message_id] = id;
        if (parentQMsg == null) { rootId = id; rootCount++; }
        const ans = messages.find(x => x.role === "ASSISTANT" && x.parent_id === m.message_id);
        if (ans) nodes[id].answer = ans.content || "";
      });
      if (rootCount > 1) warnings.push("分享内容中有 " + rootCount + " 条无父问题的消息，已取最后一条作为根节点");
      return { nodes, rootId, warnings };
    }

    /* ---- 祖先链上下文（AskTree buildContext 移植）---- */
    function buildContext(tree, nodeId, systemPrompt) {
      const nodes = tree && tree.nodes ? tree.nodes : {};
      const chain = [];
      let cur = nodes[nodeId];
      if (!cur) throw new Error("节点 " + nodeId + " 不存在于树中（可用根节点：" + (tree && tree.rootId ? tree.rootId : "无") + "）");
      while (cur) { chain.unshift(cur); cur = cur.parentId ? nodes[cur.parentId] : null; }
      const messages = [];
      chain.forEach(n => {
        if (n.text) messages.push({ role: "user", content: String(n.text) });
        if (n.answer && !/^生成失败/.test(n.answer)) messages.push({ role: "assistant", content: String(n.answer) });
      });
      return { system: systemPrompt || SYSTEM_PROMPT, messages, chain: chain.map(n => n.id) };
    }

    /* ---- 问答轮次 → 线性树 ---- */
    function linearTreeFromTurns(turns) {
      const nodes = {};
      let rootId = null, prev = null, nextId = 1;
      turns.forEach(t => {
        const id = "n" + (nextId++);
        nodes[id] = { id, text: t.q || "", answer: t.a || "", parentId: prev, children: [] };
        if (prev) nodes[prev].children.push(id);
        else rootId = id;
        prev = id;
      });
      return { nodes, rootId };
    }

    /* ============ 网络通道 ============ */
    function extractShareId(s) {
      s = (s || "").trim();
      if (/^[a-zA-Z0-9]+$/.test(s)) return s;
      const m = s.match(/share\/([a-zA-Z0-9]+)/) || s.match(/[?&]share_id=([a-zA-Z0-9]+)/i);
      return m ? m[1] : null;
    }
    function channelNames(c) {
      const names = [];
      const web = c.get("web");
      if (web && typeof web.fetch === "function") names.push("web");
      const shell = c.get("shell");
      if (shell && typeof shell.resolve === "function" && typeof shell.run === "function") names.push("shell(curl)");
      return names;
    }
    async function httpGetViaWeb(c, url) {
      const web = c.get("web");
      if (web === undefined || typeof web.fetch !== "function") return null;
      try {
        const res = await web.fetch({ url });
        const body = res && res.body && typeof res.body.content === "string" ? res.body.content : "";
        return { statusCode: res && typeof res.statusCode === "number" ? res.statusCode : 0, body };
      } catch (e) { return null; }
    }
    async function httpGetViaShell(c, url, signal) {
      const shell = c.get("shell");
      if (shell === undefined || typeof shell.resolve !== "function" || typeof shell.run !== "function") return null;
      try {
        const cmd = "curl.exe -sS -f --max-time 20 \"" + url + "\"";
        const spec = shell.resolve({ command: cmd, timeoutMs: 25000, stdoutMaxBytes: 4000000, signal });
        const result = await shell.run(spec);
        if (result.exitCode !== 0) return null;
        const out = result.stdout || {};
        if (typeof out.text !== "string" || !out.text) return null;
        return { statusCode: 200, body: out.text };
      } catch (e) { return null; }
    }
    async function fetchShareData(c, shareId, signal) {
      const direct = "https://chat.deepseek.com/api/v0/share/content?share_id=" + encodeURIComponent(shareId);
      const tryParse = r => {
        if (!(r && r.statusCode >= 200 && r.statusCode < 300)) return null;
        try {
          const j = JSON.parse(r.body);
          if (j && j.data && j.data.biz_data) return j.data.biz_data;
        } catch (e) {}
        return null;
      };
      let biz = tryParse(await httpGetViaWeb(c, direct));
      if (!biz) biz = tryParse(await httpGetViaShell(c, direct, signal));
      if (biz) return { data: biz, via: "direct" };
      const prox = "https://api.allorigins.win/raw?url=" + encodeURIComponent(direct);
      let biz2 = tryParse(await httpGetViaWeb(c, prox));
      if (!biz2) biz2 = tryParse(await httpGetViaShell(c, prox, signal));
      if (!biz2) {
        const ch = channelNames(c);
        const envHint = ch.length
          ? "（当前环境疑似阻止 HTTPS 出网，或 web fetch provider 未挂载/不可用——导入可能在此环境不可用）"
          : "（本机未提供任何网络通道）";
        throw new Error("无法获取分享内容：直连与第三方代理均失败，或链接已失效" + envHint + "。可改用手动打开分享页 → 全选复制正文，调用 asktree_parse_chat 导入（并列分支会丢失，但问答内容完整）");
      }
      return { data: biz2, via: "proxy" };
    }

    /* ============ 粘贴文本解析（AskTree parseChatTurns 移植）============ */
    function chatLines(text) {
      return String(text).split("\n").map(l => l.trim()).filter(Boolean);
    }
    function qScore(q) {
      let s = 0;
      if (Q_SPEECH_RE.test(q)) s += 4;
      if (/[?？]\s*$/.test(q)) s += 4;
      if (q.length < 150) s += 1;
      return s;
    }
    function aScore(a, nLines) {
      let s = 0;
      const first = String(a).split("\n")[0] || "";
      if (first.length >= 40) s += 2;
      if (/(^#|\*\*|\||^\s*[-*]\s|^\d+[.、]\s)/m.test(a)) s += 1;
      if (nLines >= 3) s += 1;
      return s;
    }
    function splitQA(seg) {
      const raw = seg.slice();
      if (raw.length === 1) {
        return { q: raw[0].replace(AI_END_RE, "").replace(/\s+$/, "").trim(), a: "" };
      }
      let best = { score: -1, i: 1 };
      for (let i = 1; i < raw.length; i++) {
        const q = raw.slice(0, i).join("\n");
        const aLines = raw.slice(i);
        const score = qScore(q) + aScore(aLines.join("\n"), aLines.length);
        if (score > best.score) best = { score, i };
      }
      return {
        q: raw.slice(0, best.i).join("\n").trim(),
        a: raw.slice(best.i).map(l => l.replace(/\*{0,2}\s*本回答由 AI 生成[\s\S]*$/, "").trim()).filter(Boolean).join("\n").replace(/\s+$/, "").trim()
      };
    }
    function genericTurns(lines) {
      const turns = [];
      let q = null;
      lines.forEach(l => {
        if (!q) { q = l; return; }
        if (/[?？]\s*$/.test(l) && l.length < 200) { q += "\n" + l; return; }
        turns.push({ q, a: l });
        q = null;
      });
      if (q && turns.length) turns[turns.length - 1].a += "\n" + q;
      return turns;
    }
    function parseChatTurns(text) {
      const lines = chatLines(text);
      if (!lines.length) return null;
      const segs = [];
      let buf = [], hasMarker = false;
      lines.forEach(l => {
        buf.push(l);
        if (AI_END_RE.test(l)) { hasMarker = true; segs.push(buf); buf = []; }
      });
      if (buf.length) segs.push(buf);
      let turns = [];
      if (hasMarker) {
        segs.forEach(seg => {
          const r = splitQA(seg);
          if (r.q) turns.push({ q: r.q, a: r.a });
        });
      }
      if (!turns.length) turns = genericTurns(lines);
      return turns.length ? turns : null;
    }

    /* ============ 回答通道：宿主 llm 路由 ============ */
    async function resolveRoute(c, providerArg, modelArg) {
      const llm = c.get("llm");
      if (llm === undefined || typeof llm.stream !== "function") throw new Error("宿主未提供 llm 服务，无法生成回答");
      let provider = typeof providerArg === "string" && providerArg ? providerArg : null;
      let model = typeof modelArg === "string" && modelArg ? modelArg : null;
      const adm = c.get("agentDefaultModel");
      if (adm && typeof adm.currentSelection === "function") {
        try {
          const sel = adm.currentSelection();
          if (sel) {
            if (!provider && sel.provider) provider = String(sel.provider);
            if (!model && sel.model) model = String(sel.model);
          }
        } catch (e) {}
      }
      if (!provider && typeof llm.listProviders === "function") {
        try {
          const providers = llm.listProviders() || [];
          const ds = providers.find(p => p && /deepseek/i.test(String(p.id)));
          if (ds) provider = String(ds.id);
          else if (providers.length) provider = String(providers[0].id);
        } catch (e) {}
      }
      if (!provider) throw new Error("无法确定 provider：请显式传 provider，或确认宿主已配置 LLM 提供方");
      if (!model) throw new Error("无法确定 model：请显式传 model，或确认宿主已配置默认模型");
      return { llm, provider, model };
    }

    async function streamAnswer(route, messages, system, temperature, maxTokens, signal) {
      // 关键：wire 消息必须带 source（assistant 消息会被 runtime 的 forAdapter 读 source.kind），
      // content 必须是 [{ type:'text', text }] 块数组。
      const wire = messages.map(m => ({
        role: m.role,
        content: [{ type: "text", text: String(m.content) }],
        ...(m.role === "assistant" ? { source: { kind: "model", provider: route.provider, model: route.model } } : {})
      }));
      let text = "", usage = null, failure = null;
      try {
        for await (const chunk of route.llm.stream({
          provider: route.provider,
          model: route.model,
          messages: wire,
          system,
          temperature,
          maxTokens,
          signal
        })) {
          if (chunk.type === "text-delta") text += chunk.text;
          else if (chunk.type === "usage" && chunk.usage) usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens };
          else if (chunk.type === "finish" && chunk.reason && chunk.reason.kind === "error") {
            failure = chunk.reason.failure && (chunk.reason.failure.message || chunk.reason.failure.code);
          }
        }
      } catch (e) {
        const detail = e && e.stack ? String(e.stack) : (e && e.message ? String(e.message) : String(e));
        console.error("[asktree] llm.stream 失败 route=" + route.provider + "/" + route.model + " :: " + detail);
        throw new Error("生成失败（route=" + route.provider + "/" + route.model + "）：" + (e && e.message ? e.message : String(e)));
      }
      if (failure) throw new Error("生成失败：" + failure);
      if (!text) throw new Error("生成失败：模型返回为空（可能是 maxTokens 过小或上下文过长）");
      return { text, usage };
    }

    /* ============ 工具定义 ============ */
    const jsonOutput = () => ({
      schema: { type: "object", additionalProperties: true },
      render(args, value) { return [{ type: "text", text: JSON.stringify(value, null, 2) }]; }
    });

    const tools = [
      harness.defineTool({
        name: "asktree_import_share",
        description: "从 DeepSeek 分享链接（或 share_id）抓取对话并重建为「问答树」JSON，能还原网页对话中同一处发散出的并列追问（父问题 → 多个并列子问题）。返回 { ok, title, via, rootId, count, nodeCount, nodes }：nodes 为 { id: { id, text, answer, parentId, children[] } } 的扁平结构（与 AskTree 节点 schema 一致），可直接喂给 asktree_build_context / asktree_answer，并会自动同步到 GUI 画布。直连失败时经 api.allorigins.win 第三方代理兜底（内容会经该代理中转）。注意：本工具依赖宿主挂载 web fetch provider 或允许 shell 出网；若当前环境两者均不可用（沙箱拦截 HTTPS），请改用手动粘贴正文走 asktree_parse_chat。",
        parameters: {
          type: "object",
          properties: {
            source: { type: "string", description: "DeepSeek 分享链接（https://chat.deepseek.com/share/xxxx）或纯 share_id" }
          },
          required: ["source"]
        },
        output: jsonOutput(),
        async execute(args, exec) {
          const source = args && typeof args.source === "string" ? args.source.trim() : "";
          if (!source) throw new Error("缺少 source：请传入 DeepSeek 分享链接或 share_id");
          const shareId = extractShareId(source);
          if (!shareId) throw new Error("无法从链接中识别 share_id，请确认是 https://chat.deepseek.com/share/xxxx 格式");
          const { data, via } = await fetchShareData(ctx, shareId, exec.signal);
          const msgs = data && data.messages ? data.messages : [];
          if (!msgs.length) throw new Error("对话内容为空（分享链接可能已失效）");
          const built = buildTreeFromMessages(msgs);
          const title = data.title && data.title !== "Shared Conversation" ? String(data.title) : null;
          setStore(built.tree, title, via, via === "proxy" ? "内容经 api.allorigins.win 第三方代理中转" : null);
          const out = {
            ok: true,
            title,
            via,
            rootId: built.rootId,
            count: msgs.length,
            nodeCount: Object.keys(built.nodes).length,
            nodes: built.nodes,
            notice: "已同步到 GUI 画布（点会话栏「树」按钮查看）"
          };
          if (built.warnings.length) out.warnings = built.warnings;
          return out;
        }
      }),

      harness.defineTool({
        name: "asktree_parse_chat",
        description: "把复制的网页对话正文解析为问答轮次并串成线性树。DeepSeek 分享页全选复制的正文识别最准（每条回答自带「本回答由 AI 生成，内容仅供参考」结尾标记）。返回 { ok, mode: marker|generic, turns:[{q,a}], tree:{nodes,rootId}, count }，并会自动同步到 GUI 画布。局限：纯文本没有 parent_id，只能重建线性链，并列分支会丢失；要保留分支请用 asktree_import_share。",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "复制的对话正文（DeepSeek 分享页全选复制的内容，或任意「问题+回答」交替文本）" }
          },
          required: ["text"]
        },
        output: jsonOutput(),
        async execute(args, exec) {
          const text = args && typeof args.text === "string" ? args.text : "";
          if (!text.trim()) throw new Error("缺少 text：请粘贴对话正文");
          if (/^https?:\/\//.test(text.trim())) throw new Error("检测到链接而非正文：请改用 asktree_import_share 传入分享链接，或将链接打开后全选复制正文再粘贴");
          const turns = parseChatTurns(text);
          if (!turns || !turns.length) throw new Error("未能识别出对话结构：请确认粘贴的是「问题 + 回答」交替的内容（DeepSeek 分享页复制的内容识别最准）");
          const tree = linearTreeFromTurns(turns);
          setStore(tree, null, "paste", null);
          return { ok: true, mode: AI_END_RE.test(text) ? "marker" : "generic", turns, tree, count: turns.length, notice: "已同步到 GUI 画布（点会话栏「树」按钮查看）" };
        }
      }),

      harness.defineTool({
        name: "asktree_show",
        description: "把一棵问答树同步到 GUI 画布显示（不校验来源，适合直接把任意符合 { nodes, rootId } 形状的树推给画布）。传 tree 则替换当前画布内容；不传则仅返回当前画布状态。返回 { ok, tree, title, via, notice }。",
        parameters: {
          type: "object",
          properties: {
            tree: { type: "object", description: "可选：问答树 { nodes: { id: {id,text,answer,parentId,children[]} }, rootId }" },
            title: { type: "string", description: "可选：画布标题" },
            via: { type: "string", description: "可选：来源标注（如 direct/proxy/paste/json）" }
          }
        },
        output: jsonOutput(),
        async execute(args, exec) {
          if (args && args.tree && args.tree.nodes && args.tree.rootId) {
            setStore(args.tree, args.title || store.title, args.via || "json", null);
          }
          return { ok: true, tree: store.tree, title: store.title, via: store.via, notice: "已同步到 GUI 画布（点会话栏「树」按钮查看）" };
        }
      }),

      harness.defineTool({
        name: "asktree_build_context",
        description: "AskTree buildContext 移植：取「从根问题到目标节点的整条祖先链」拼成 messages（[user, assistant, user, assistant, ...]），不包含兄弟分支——省 token 且分支记忆不串线。返回 { ok, system, messages, chain, nodeCount }，messages 可直接传给 asktree_answer。tree 形状：{ nodes: { id: {id, text, answer, parentId, children[]} }, rootId }（由 asktree_import_share / asktree_parse_chat 产出）。",
        parameters: {
          type: "object",
          properties: {
            tree: { type: "object", description: "问答树对象 { nodes, rootId }" },
            nodeId: { type: "string", description: "目标节点 id，取从根到该节点的祖先链作为上下文" },
            systemPrompt: { type: "string", description: "可选：覆盖默认 system 提示词" }
          },
          required: ["tree", "nodeId"]
        },
        output: jsonOutput(),
        async execute(args, exec) {
          const tree = args && args.tree ? args.tree : null;
          const nodeId = args && args.nodeId ? String(args.nodeId) : "";
          if (!tree || !nodeId) throw new Error("需要 tree（问答树对象）与 nodeId（目标节点 id）");
          const c = buildContext(tree, nodeId, typeof args.systemPrompt === "string" ? args.systemPrompt : undefined);
          return { ok: true, system: c.system, messages: c.messages, chain: c.chain, nodeCount: c.messages.length };
        }
      }),

      harness.defineTool({
        name: "asktree_answer",
        description: "基于祖先链上下文生成回答（AskTree generateAnswer + callApi 的宿主版）：传 tree+nodeId 会自动拼装上下文，或直接传 messages（[{role:user|assistant, content}]）。走宿主 llm 路由：provider/model 缺省取当前默认模型选择，可显式覆盖。返回 { ok, answer, provider, model, temperature, maxTokens, usage }。",
        parameters: {
          type: "object",
          properties: {
            tree: { type: "object", description: "问答树对象；与 nodeId 一起使用（二选一：tree+nodeId 或直接传 messages）" },
            nodeId: { type: "string", description: "目标节点 id，自动拼装祖先链上下文后生成回答" },
            messages: { type: "array", items: { type: "object", description: "{ role: 'user'|'assistant', content: string }" }, description: "直接传入问答消息数组（跳过 tree+nodeId 自动拼装）" },
            system: { type: "string", description: "system 提示词；缺省使用树形问答专用提示词" },
            provider: { type: "string", description: "LLM provider 路由（缺省取当前默认模型选择）" },
            model: { type: "string", description: "模型 id（缺省取当前默认模型）" },
            temperature: { type: "number", description: "采样温度，默认 0.6" },
            maxTokens: { type: "integer", description: "最大输出 token，默认 900" }
          }
        },
        output: {
          schema: { type: "object", additionalProperties: true },
          render(args, value) {
            return [{ type: "text", text: "【asktree_answer】" + value.provider + "/" + value.model + "\n\n" + value.answer }];
          }
        },
        async execute(args, exec) {
          const tree = args && args.tree ? args.tree : null;
          const nodeId = args && args.nodeId ? String(args.nodeId) : "";
          let messages = null, system = null;
          if (tree && nodeId) {
            const c = buildContext(tree, nodeId, typeof args.system === "string" ? args.system : undefined);
            messages = c.messages;
            system = c.system;
          } else if (Array.isArray(args.messages) && args.messages.length) {
            const out = [];
            for (const m of args.messages) {
              const role = m && m.role ? String(m.role) : "";
              const content = m && m.content != null ? String(m.content) : "";
              if (role === "system") { if (system === null) system = content; continue; }
              if (role !== "user" && role !== "assistant") throw new Error("messages 仅支持 role: user / assistant（system 请用 system 字段）");
              out.push({ role, content });
            }
            if (!out.length) throw new Error("messages 为空（或只有 system）");
            messages = out;
            if (system === null) system = SYSTEM_PROMPT;
          } else {
            throw new Error("需要提供 tree+nodeId（自动拼装祖先链上下文），或直接传 messages（问答消息数组）");
          }
          const temperature = typeof args.temperature === "number" ? args.temperature : 0.6;
          const maxTokens = typeof args.maxTokens === "number" ? args.maxTokens : 900;
          const route = await resolveRoute(ctx, args.provider, args.model);
          const r = await streamAnswer(route, messages, system, temperature, maxTokens, exec.signal);
          return { ok: true, answer: r.text, provider: route.provider, model: route.model, temperature, maxTokens, usage: r.usage };
        }
      })
    ];

    tools.forEach(t => ctx.effect(() => harness.registerTool(ctx, t)));
    console.log("[asktree] 已注册工具: " + tools.map(t => t.name).join(", "));

    /* ============ GUI 画布 RPC ============ */
    ctx.effect(() => harness.handle("asktree.getTree", () => snapshot()));
    ctx.effect(() => harness.handle("asktree.mutate", async (args) => {
      const op = args && args.op;
      if (op === "demo") {
        setStore(JSON.parse(JSON.stringify(DEMO_TREE)), "示例：深度学习×量化投资", "demo", null);
        return snapshot();
      }
      if (op === "load") {
        if (!args.tree || !args.tree.nodes || !args.tree.rootId) throw new Error("load 需要合法的 tree { nodes, rootId }");
        setStore(args.tree, args.title || store.title, args.via || "json", null);
        return snapshot();
      }
      if (!store.tree) throw new Error("尚未导入任何树：先让模型运行 asktree_import_share / asktree_parse_chat，或点「载入示例树」");
      switch (op) {
        case "addChild": {
          const parentId = String(args.parentId);
          const text = typeof args.text === "string" ? args.text.trim() : "";
          requireNode(parentId);
          if (!text) throw new Error("子问题内容为空");
          const id = nextNodeId(store.tree);
          store.tree.nodes[id] = { id, text, answer: "", parentId, children: [] };
          store.tree.nodes[parentId].children.push(id);
          if (args.autoAnswer) {
            try { await answerNode(id); } catch (e) { store.tree.nodes[id].answer = "生成失败：" + (e && e.message ? e.message : e); }
          }
          return snapshot();
        }
        case "answer": {
          const id = String(args.nodeId);
          requireNode(id);
          try { await answerNode(id); } catch (e) { throw new Error("生成失败：" + (e && e.message ? e.message : e)); }
          return snapshot();
        }
        case "save": {
          const n = requireNode(String(args.nodeId));
          if (typeof args.text === "string") n.text = args.text;
          if (typeof args.answer === "string") n.answer = args.answer;
          return snapshot();
        }
        case "remove": {
          const id = String(args.nodeId);
          requireNode(id);
          removeSubtree(store.tree, id);
          if (!store.tree.rootId) store.tree = null;
          return snapshot();
        }
        case "setTitle": {
          store.title = typeof args.title === "string" ? args.title : null;
          return snapshot();
        }
        default:
          throw new Error("未知操作：" + op);
      }
    }));
  }
};
