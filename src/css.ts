/**
 * 画布样式（AskTree 原样式移植 + 深/浅两套配色）。
 *
 * 用 `ctx.get('styles')` / 客户端 styles 服务插入，随插件卸载自动清理。
 * 深浅色通过根节点上的 `.at-light` 类切换（见 `theme` 状态）。
 */
export const CANVAS_CSS = `
.at-toggle{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;font-size:12.5px;color:#a8b0c0;background:transparent;border:1px solid transparent;cursor:pointer;white-space:nowrap}
.at-toggle:hover{background:#222735;color:#e8ebf2}
.at-toggle.at-on{background:#1e4d86;color:#cfe3fb;border-color:#2f6cb3}
.at-toggle.at-compact{padding:2px 8px;font-size:12px}
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
.at-panel.at-light{background:#eef1f6;border-color:#d6dce6;color:#1b2230}
.at-panel.at-light .at-head{background:#ffffff;border-color:#d6dce6}
.at-panel.at-light .at-title{color:#1b2230}
.at-panel.at-light .at-count,.at-panel.at-light .at-spinner-wrap{color:#8b94a7}
.at-panel.at-light .at-hbtn{color:#495264}
.at-panel.at-light .at-hbtn:hover{background:#e8ecf3;color:#1b2230}
.at-panel.at-light .at-body{background-color:#eef1f6;background-image:linear-gradient(rgba(15,23,42,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.07) 1px,transparent 1px)}
.at-panel.at-light .at-block{background:#ffffff;border-color:#c3ccda;box-shadow:0 2px 10px rgba(15,23,42,.10)}
.at-panel.at-light .at-block:hover{border-color:#9cc2ec}
.at-panel.at-light .at-block.at-selected{border-color:#2f6cb3;box-shadow:0 0 0 1.5px #2f6cb3,0 4px 18px rgba(47,108,179,.20)}
.at-panel.at-light .at-q{background:#e9f1fc;border-color:#9cc2ec;color:#14528f}
.at-panel.at-light .at-link{stroke:rgba(15,23,42,.40)}
.at-panel.at-light .at-meta{color:#8b94a7}
.at-panel.at-light .at-meta:hover{color:#495264;background:#e8ecf3}
.at-panel.at-light .at-cbtn{color:#495264;border-color:#c3ccda}
.at-panel.at-light .at-cbtn:hover{background:#e8ecf3;color:#1b2230}
.at-panel.at-light .at-msg{background:#e8ecf3;border-color:#c3ccda;color:#1b2230}
.at-panel.at-light .at-empty{color:#495264}
.at-panel.at-light .at-inspector{background:#ffffff;border-color:#d6dce6}
.at-panel.at-light .at-ta{background:#ffffff;border-color:#d6dce6;color:#1b2230}
.at-panel.at-light .at-preview{background:#ffffff;border-color:#d6dce6}
.at-panel.at-light .at-md{color:#1b2230}
.at-panel.at-light .at-md .at-icode,.at-panel.at-light .at-md .at-code,.at-panel.at-light .at-md .at-quote{background:#e8ecf3;border-color:#d6dce6;color:#495264}
.at-panel.at-light .at-md strong{color:#1b2230}
.at-panel.at-light .at-addbox{background:#ffffff;border-color:#9cc2ec}
.at-panel.at-light .at-chev{color:#8b94a7}
.at-panel.at-light .at-chev:hover{color:#1b2230;background:#e8ecf3}
.at-panel.at-light .at-grip{color:#8b94a7}
.at-panel.at-light .at-add{background:#e8ecf3;border-color:#2f9e6b;color:#2f9e6b}
.at-panel.at-light .at-add:hover{background:#e4f5ec;color:#1d7d52}
.at-panel.at-light .at-badge{background:#e9f1fc;border-color:#9cc2ec;color:#14528f}
.at-panel.at-light .at-badge.via{background:#e4f5ec;border-color:#2f9e6b;color:#2f9e6b}
.at-panel.at-light .at-spinner{border-color:#d6dce6;border-top-color:#2f6cb3}
`
