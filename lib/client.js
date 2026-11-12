/**
 * codegraph wiring, browser half.
 *
 * Adds two rows to the sidebar workspace "…" menu — install and uninstall —
 * and answers both with one dialog that streams the Host's step log. The
 * dialog lives on `shell.overlay` because a menu row unmounts with its menu.
 *
 * This file is served raw as a classic script and registers a factory; every
 * side effect, including `React.createElement` work, stays inside it. No
 * Harness client package is required: the dialog is plain DOM plus the
 * `--dsw-alias-*` theme tokens, so a missing or renamed primitive cannot break
 * the plugin.
 */
window.__ModuleLoader__.load({
	id: "dsh-codegraph-init",
	factory(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;

		/** Dictionary namespace owned by this plugin. */
		var NS = "codegraphInit";

		/** Simplified Chinese dictionary (the key-set source of truth). */
		var zh = {
			"menu.install": "安装 codegraph",
			"menu.uninstall": "卸载 codegraph",
			"dialog.install.title": "安装 codegraph 并接入 DSH？",
			"dialog.uninstall.title": "卸载 codegraph 接线？",
			"dialog.install.desc": "会全局安装 npm 包 codegraph（已装则跳过），然后把一个 codegraph MCP 服务写进当前 DSH 家目录。",
			"dialog.uninstall.desc": "会移除 DSH 的 MCP 接线与说明块。不会删除任何仓库里的 .codegraph/ 索引，也不会动你在别处配好的其它 agent。",
			"scope": "工作区",
			"status.loading": "正在读取当前状态…",
			"status.failed": "读取状态失败",
			"status.cli": "codegraph CLI",
			"status.cli.missing": "未安装",
			"status.cli.present": "{version} · {path}",
			"status.wiring": "DSH 接线",
			"status.wiring.on": "已接入 {path}",
			"status.wiring.off": "未接入 {path}",
			"status.target": "dsh installer 目标",
			"status.target.yes": "当前 CLI 支持，交给 codegraph install 执行",
			"status.target.no": "当前 npm 版还没有该目标，由插件直接写接线",
			"notes.heading": "安装会做三件事",
			"notes.cli": "确保 PATH 上有 codegraph（npm install -g）。",
			"notes.wiring": "在 cordis.patch.yml 里加一条 codegraph MCP 服务，并在 AGENTS.md 里加一段使用说明。",
			"notes.restart": "新开一个会话后生效；若 dsh-hmr 已关闭，需要重启 DSH。",
			"notes.uninstall.heading": "卸载会做两件事",
			"notes.uninstall.wiring": "移除 cordis.patch.yml 里的 codegraph 行与 AGENTS.md 里的说明块。",
			"notes.uninstall.cli": "保留全局 CLI（可在下面勾选一并移除），.codegraph/ 索引不受影响。",
			"option.removeCli": "同时移除全局 CLI（npm uninstall -g codegraph）",
			"log.heading": "执行日志",
			"log.empty": "等待开始…",
			"log.truncated": "（较早的 {n} 行已省略）",
			"action.install": "开始安装",
			"action.uninstall": "开始卸载",
			"action.cancel": "中止并关闭",
			"action.close": "关闭",
			"action.again": "重新运行",
			"action.starting": "正在启动…",
			"result.ok": "完成",
			"result.failed": "失败",
			"result.cancelled": "已中止",
			"result.hint": "把上面日志里的失败原因贴给 agent，通常就能定位。",
			"close": "关闭"
		};

		/** English dictionary, checked complete against the zh key set. */
		var en = {
			"menu.install": "Install codegraph",
			"menu.uninstall": "Uninstall codegraph",
			"dialog.install.title": "Install codegraph and wire it into DSH?",
			"dialog.uninstall.title": "Remove the codegraph wiring?",
			"dialog.install.desc": "Installs the codegraph npm package globally (skipped when present), then writes one codegraph MCP server into this DSH home.",
			"dialog.uninstall.desc": "Removes the DSH wiring and its instructions block. No repository .codegraph/ index is touched, and other agents you configured elsewhere stay as they are.",
			"scope": "Workspace",
			"status.loading": "Reading the current state…",
			"status.failed": "Could not read the current state",
			"status.cli": "codegraph CLI",
			"status.cli.missing": "not installed",
			"status.cli.present": "{version} · {path}",
			"status.wiring": "DSH wiring",
			"status.wiring.on": "wired in {path}",
			"status.wiring.off": "not wired in {path}",
			"status.target": "dsh installer target",
			"status.target.yes": "this CLI has it; codegraph install runs the wiring",
			"status.target.no": "the published npm build lacks it, so the plugin writes the wiring",
			"notes.heading": "Installing does three things",
			"notes.cli": "Makes sure codegraph is on PATH (npm install -g).",
			"notes.wiring": "Adds one codegraph MCP server to cordis.patch.yml and a usage block to AGENTS.md.",
			"notes.restart": "Takes effect in a new session; restart DSH if dsh-hmr is off.",
			"notes.uninstall.heading": "Uninstalling does two things",
			"notes.uninstall.wiring": "Drops the codegraph row from cordis.patch.yml and the block from AGENTS.md.",
			"notes.uninstall.cli": "Keeps the global CLI (tick the box below to remove it too); .codegraph/ indexes are untouched.",
			"option.removeCli": "Also remove the global CLI (npm uninstall -g codegraph)",
			"log.heading": "Run log",
			"log.empty": "Waiting to start…",
			"log.truncated": "({n} earlier lines omitted)",
			"action.install": "Install",
			"action.uninstall": "Uninstall",
			"action.cancel": "Abort and close",
			"action.close": "Close",
			"action.again": "Run again",
			"action.starting": "Starting…",
			"result.ok": "Done",
			"result.failed": "Failed",
			"result.cancelled": "Aborted",
			"result.hint": "Paste the failure from the log into a chat with an agent; it usually pinpoints the cause.",
			"close": "Close"
		};

		/**
		 * One tiny observable store: the slot hook face wants a
		 * `{getSnapshot, subscribe}` pair, and nothing else here needs a store
		 * library.
		 *
		 * @param {*} initial - Starting snapshot.
		 * @returns {{getSnapshot: Function, subscribe: Function, set: Function}} the store.
		 */
		function createStore(initial) {
			var value = initial;
			var listeners = new Set();
			return {
				getSnapshot: function getSnapshot() {
					return value;
				},
				subscribe: function subscribe(listener) {
					listeners.add(listener);
					return function unsubscribe() {
						listeners.delete(listener);
					};
				},
				set: function set(next) {
					value = next;
					Array.from(listeners).forEach(function notify(listener) {
						listener();
					});
				}
			};
		}

		/**
		 * Call one `codegraphInstall` host method over the ordinary API RPC
		 * channel and unwrap its result envelope.
		 *
		 * @param {object} ctx - Client context carrying the Connection.
		 * @param {string} method - Host method name.
		 * @param {object} request - Wire request body.
		 * @returns {Promise<*>} the decoded host result.
		 */
		function callHost(ctx, method, request) {
			return Promise.resolve(ctx.connection.rpc.call("/api", "codegraphInstall/" + method, { args: { request: request } })).then(function unwrap(result) {
				if (!result.ok) {
					var failure = new Error(result.error && result.error.message ? result.error.message : "the host refused codegraphInstall/" + method);
					failure.code = result.error && result.error.code;
					throw failure;
				}
				return result.value;
			});
		}

		/** Stylesheet: hover and focus states need real CSS, so one is injected once. */
		var STYLE_ID = "dsh-codegraph-init-style";
		var CSS = [
			".dshcg-backdrop{position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-2,rgba(0,0,0,.45));}",
			".dshcg-card{display:flex;flex-direction:column;width:min(680px,100%);max-height:min(80vh,760px);overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:14px;background:var(--dsw-alias-bg-elevated,#1e1f23);color:var(--dsw-alias-label-primary,#eee);box-shadow:var(--dsw-elevation-panel,0 24px 64px rgba(0,0,0,.45));font-family:inherit;}",
			".dshcg-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 12px;}",
			".dshcg-head h2{margin:0;font-size:15px;font-weight:600;line-height:1.4;flex:1;}",
			".dshcg-x{flex:none;width:24px;height:24px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;font-size:15px;line-height:1;}",
			".dshcg-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#eee);}",
			".dshcg-body{display:flex;flex-direction:column;gap:14px;padding:0 20px 4px;overflow:auto;}",
			".dshcg-desc{margin:0;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary,#b6b8bd);}",
			".dshcg-meta{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12px;line-height:1.6;}",
			".dshcg-meta dt{color:var(--dsw-alias-label-tertiary,#8b8e95);white-space:nowrap;}",
			".dshcg-meta dd{margin:0;color:var(--dsw-alias-label-secondary,#b6b8bd);word-break:break-all;}",
			".dshcg-section{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,#8b8e95);}",
			".dshcg-list{margin:0;padding-left:18px;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#b6b8bd);}",
			".dshcg-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#b6b8bd);cursor:pointer;}",
			".dshcg-log{min-height:132px;max-height:280px;overflow:auto;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.09));border-radius:10px;background:var(--dsw-alias-bg-l1,rgba(255,255,255,.03));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;}",
			".dshcg-log div{white-space:pre-wrap;word-break:break-word;}",
			".dshcg-step{color:var(--dsw-alias-label-primary,#eee);font-weight:600;}",
			".dshcg-out{color:var(--dsw-alias-label-secondary,#b6b8bd);}",
			".dshcg-note{color:var(--dsw-alias-label-tertiary,#8b8e95);}",
			".dshcg-err{color:var(--dsw-alias-label-error,#f2737a);}",
			".dshcg-ok{color:var(--dsw-alias-state-business-primary,#4ec07a);}",
			".dshcg-empty{padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8e95);}",
			".dshcg-banner{margin:0;padding:9px 12px;border-radius:9px;font-size:12.5px;line-height:1.6;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));}",
			".dshcg-banner[data-tone=ok]{border-color:var(--dsw-alias-state-business-primary,#4ec07a);color:var(--dsw-alias-state-business-primary,#4ec07a);}",
			".dshcg-banner[data-tone=bad]{border-color:var(--dsw-alias-state-error-primary,#f2737a);color:var(--dsw-alias-state-error-primary,#f2737a);}",
			".dshcg-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px 18px;}",
			".dshcg-btn{min-width:88px;height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:13px;font-family:inherit;cursor:pointer;}",
			".dshcg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));}",
			".dshcg-btn:disabled{opacity:.5;cursor:default;}",
			".dshcg-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#4b7bf5);color:var(--dsw-alias-label-on-color,#fff);}",
			".dshcg-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#5b88f7);}",
			".dshcg-btn[data-variant=quiet]{border-color:transparent;color:var(--dsw-alias-label-secondary,#b6b8bd);}"
		].join("");

		/**
		 * Install the stylesheet once, and remove it when the plugin unloads.
		 *
		 * @returns {Function} disposer.
		 */
		function installStyles() {
			if (document.getElementById(STYLE_ID) !== null) return function noop() {};
			var element = document.createElement("style");
			element.id = STYLE_ID;
			element.textContent = CSS;
			document.head.appendChild(element);
			return function removeStyles() {
				element.remove();
			};
		}

		/**
		 * Interpolate `{name}` placeholders; the dictionaries stay plain data.
		 *
		 * @param {string} template - Localized string.
		 * @param {object} params - Replacement values.
		 * @returns {string} the rendered string.
		 */
		function fill(template, params) {
			return template.replace(/\{(\w+)\}/gu, function replace(match, key) {
				return params[key] === undefined ? match : String(params[key]);
			});
		}

		/** One graph icon, drawn locally so no icon package has to be present. */
		function GraphIcon(props) {
			var size = props && props.size ? props.size : 14;
			return h(
				"svg",
				{ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("circle", { cx: 6, cy: 6, r: 2.4 }),
				h("circle", { cx: 18, cy: 6, r: 2.4 }),
				h("circle", { cx: 12, cy: 18, r: 2.4 }),
				h("path", { d: "M8.4 6h7.2" }),
				h("path", { d: "M7.3 8.1 10.8 15.9" }),
				h("path", { d: "M16.7 8.1 13.2 15.9" }),
				props && props.slash ? h("path", { d: "M4 20 20 4" }) : null
			);
		}

		/** Keyed icon for the install row. */
		function IconInstall(props) {
			return h(GraphIcon, { size: (props && props.icon && props.icon.size) || 14 });
		}

		/** Keyed icon for the uninstall row. */
		function IconUninstall(props) {
			return h(GraphIcon, { size: (props && props.icon && props.icon.size) || 14, slash: true });
		}

		/**
		 * The dialog shell: backdrop, card, header, scrolling body and footer.
		 *
		 * @param {object} props - Title, description, footer, body and close handler.
		 * @returns {object} the overlay element.
		 */
		function DialogShell(props) {
			var onClose = props.onClose;
			var dismissible = props.dismissible !== false;

			// While a run streams, an accidental click outside or Escape would
			// abort an in-flight `npm install -g`; only the explicit buttons in
			// the footer close the dialog then.
			react.useEffect(
				function watchEscape() {
					if (!dismissible) return undefined;
					function onKeyDown(event) {
						if (event.key === "Escape") onClose();
					}
					document.addEventListener("keydown", onKeyDown);
					return function stopWatching() {
						document.removeEventListener("keydown", onKeyDown);
					};
				},
				[dismissible, onClose]
			);

			return h(
				"div",
				{
					className: "dshcg-backdrop",
					role: "presentation",
					onMouseDown: function onBackdrop(event) {
						if (!dismissible) return;
						if (event.target === event.currentTarget) onClose();
					}
				},
				h(
					"div",
					{ className: "dshcg-card", role: "dialog", "aria-modal": "true", "aria-label": props.title },
					h(
						"div",
						{ className: "dshcg-head" },
						h("h2", null, props.title),
						h(
							"button",
							{ type: "button", className: "dshcg-x", "aria-label": props.closeLabel, onClick: onClose },
							"✕"
						)
					),
					h("div", { className: "dshcg-body" }, props.description === undefined ? null : h("p", { className: "dshcg-desc" }, props.description), props.children),
					h("div", { className: "dshcg-foot" }, props.footer)
				)
			);
		}

		/**
		 * One status row pair for the meta list.
		 *
		 * @param {object} props - Term and detail.
		 * @returns {Array} `<dt>` and `<dd>`.
		 */
		function MetaRow(props) {
			return [h("dt", { key: props.term }, props.term), h("dd", { key: props.term + ":v" }, props.detail)];
		}

		/**
		 * The streaming log panel.
		 *
		 * @param {object} props - Lines, dropped count and empty copy.
		 * @returns {object} the panel.
		 */
		function LogPanel(props) {
			var view = props.view;
			var lines = view.lines;
			return h(
				"div",
				null,
				h("div", { className: "dshcg-section" }, props.heading),
				h(
					"div",
					{ className: "dshcg-log", role: "log", "aria-live": "polite" },
					view.dropped > 0 ? h("div", { className: "dshcg-note" }, fill(props.truncatedLabel, { n: view.dropped })) : null,
					lines.length === 0 ? h("div", { className: "dshcg-note" }, props.emptyLabel) : null,
					lines.map(function renderLine(line) {
						return h("div", { key: line.seq, className: "dshcg-" + line.kind }, line.text);
					})
				)
			);
		}

		/**
		 * The whole dialog: status, options, log and the run state machine.
		 *
		 * @param {object} props - Request hook, host calls and the locale.
		 * @returns {object|null} the dialog, or nothing while unrequested.
		 */
		function CodegraphDialog(props) {
			var request = props.useCodegraphRequest(function pick(pending) {
				return pending;
			});
			if (request === null) return null;
			return h(DialogBody, Object.assign({}, props, { request: request }));
		}

		/**
		 * The request-scoped body. Mounted per request, so its in-flight state
		 * dies with the request that raised it.
		 *
		 * @param {object} props - Same as the dialog, plus the captured request.
		 * @returns {object} the dialog contents.
		 */
		function DialogBody(props) {
			var request = props.request;
			var t = props.t;
			var settle = props.settleCodegraphRequest;
			var installing = request.action === "install";

			var statusState = react.useState(null);
			var status = statusState[0];
			var setStatus = statusState[1];
			var loadErrorState = react.useState(null);
			var loadError = loadErrorState[0];
			var setLoadError = loadErrorState[1];

			var viewState = react.useState({ lines: [], dropped: 0, done: false, ok: null, error: null, running: false });
			var view = viewState[0];
			var setView = viewState[1];

			var runState = react.useState(null);
			var runId = runState[0];
			var setRunId = runState[1];
			var startErrorState = react.useState(null);
			var startError = startErrorState[0];
			var setStartError = startErrorState[1];
			var removeCliState = react.useState(false);
			var removeCli = removeCliState[0];
			var setRemoveCli = removeCliState[1];
			var startingState = react.useState(false);
			var starting = startingState[0];
			var setStarting = startingState[1];

			var cursor = react.useRef(0);

			react.useEffect(function loadStatus() {
				var live = true;
				props.getStatus().then(function apply(next) {
					if (live) setStatus(next);
				}).catch(function fail(reason) {
					if (live) setLoadError(reason instanceof Error ? reason.message : String(reason));
				});
				return function cleanup() {
					live = false;
				};
			}, []);

			react.useEffect(function poll() {
				if (runId === null || view.done) return undefined;
				var live = true;
				var timer = setInterval(function tick() {
					props.pollRun(runId, cursor.current).then(function apply(next) {
						if (!live) return;
						cursor.current = next.next;
						if (next.lines.length === 0 && next.dropped === view.dropped && !next.done) return;
						setView(function merge(prev) {
							return {
								lines: prev.lines.concat(next.lines),
								dropped: next.dropped,
								done: next.done,
								ok: next.ok,
								error: next.error,
								running: !next.done
							};
						});
					}).catch(function fail(reason) {
						if (!live) return;
						setView(function merge(prev) {
							return Object.assign({}, prev, { done: true, ok: false, running: false, error: reason instanceof Error ? reason.message : String(reason) });
						});
					});
				}, 600);
				return function cleanup() {
					live = false;
					clearInterval(timer);
				};
			}, [runId, view.done]);

			react.useEffect(function forgetOnUnmount() {
				return function cleanup() {
					if (runId !== null) props.forgetRun(runId);
				};
			}, [runId]);

			var running = starting || view.running;
			var finish = view.done;

			var start = function start() {
				if (running) return;
				setStarting(true);
				setStartError(null);
				cursor.current = 0;
				setRunId(null);
				setView({ lines: [], dropped: 0, done: false, ok: null, error: null, running: true });
				props.startRun({ action: request.action, removeCli: removeCli }).then(function launched(result) {
					setStarting(false);
					setRunId(result.runId);
				}).catch(function fail(reason) {
					setStarting(false);
					setStartError(reason instanceof Error ? reason.message : String(reason));
					setView({ lines: [], dropped: 0, done: true, ok: false, error: reason instanceof Error ? reason.message : String(reason), running: false });
				});
			};

			var close = function close() {
				if (running && runId !== null) props.cancelRun(runId).catch(function ignore() {});
				settle();
			};

			var title = installing ? t("dialog.install.title") : t("dialog.uninstall.title");
			var description = installing ? t("dialog.install.desc") : t("dialog.uninstall.desc");

			var scopeRow = request.path
				? h("dl", { className: "dshcg-meta", key: "scope" }, MetaRow({ term: t("scope"), detail: request.displayTitle + " · " + request.path }))
				: null;

			var statusBlock;
			if (loadError !== null) {
				statusBlock = h("p", { className: "dshcg-banner", "data-tone": "bad" }, t("status.failed") + ": " + loadError);
			} else if (status === null) {
				statusBlock = h("div", { className: "dshcg-empty" }, t("status.loading"));
			} else {
				var cli = status.cli;
				var wiring = status.wiring;
				statusBlock = h(
					"dl",
					{ className: "dshcg-meta" },
					MetaRow({
						term: t("status.cli"),
						detail: cli.found ? fill(t("status.cli.present"), { version: cli.version || "?", path: cli.path || "PATH" }) : t("status.cli.missing")
					}),
					MetaRow({
						term: t("status.wiring"),
						detail: fill(wiring.configured ? t("status.wiring.on") : t("status.wiring.off"), { path: wiring.home.patchPath })
					}),
					MetaRow({ term: t("status.target"), detail: status.cliSupportsDshTarget ? t("status.target.yes") : t("status.target.no") })
				);
			}

			var notes = installing
				? h(
					"div",
					null,
					h("div", { className: "dshcg-section" }, t("notes.heading")),
					h(
						"ul",
						{ className: "dshcg-list" },
						h("li", null, t("notes.cli")),
						h("li", null, t("notes.wiring")),
						h("li", null, t("notes.restart"))
					)
				)
				: h(
					"div",
					null,
					h("div", { className: "dshcg-section" }, t("notes.uninstall.heading")),
					h(
						"ul",
						{ className: "dshcg-list" },
						h("li", null, t("notes.uninstall.wiring")),
						h("li", null, t("notes.uninstall.cli"))
					),
					h(
						"label",
						{ className: "dshcg-check" },
						h("input", {
							type: "checkbox",
							checked: removeCli,
							disabled: running,
							onChange: function onChange(event) {
								setRemoveCli(event.target.checked);
							}
						}),
						t("option.removeCli")
					)
				);

			var banner = null;
			if (finish) {
				var tone = view.ok === true ? "ok" : "bad";
				var label = view.ok === true ? t("result.ok") : view.error === "cancelled" ? t("result.cancelled") : t("result.failed");
				banner = h(
					"p",
					{ className: "dshcg-banner", "data-tone": tone, role: "status" },
					label + (view.ok === true ? "" : view.error ? "：" + view.error : ""),
					view.ok === true ? null : h("span", { className: "dshcg-note" }, " " + t("result.hint"))
				);
			}

			var primaryLabel = installing ? t("action.install") : t("action.uninstall");
			var footer;
			if (running) {
				footer = [h("button", { key: "cancel", type: "button", className: "dshcg-btn", "data-variant": "quiet", onClick: close }, t("action.cancel"))];
			} else if (finish) {
				footer = [
					h("button", { key: "again", type: "button", className: "dshcg-btn", onClick: start }, t("action.again")),
					h("button", { key: "close", type: "button", className: "dshcg-btn", "data-variant": "primary", onClick: close }, t("action.close"))
				];
			} else {
				footer = [
					h("button", { key: "close", type: "button", className: "dshcg-btn", onClick: close }, t("action.close")),
					h(
						"button",
						{ key: "go", type: "button", className: "dshcg-btn", "data-variant": "primary", disabled: starting, onClick: start },
						starting ? t("action.starting") : primaryLabel
					)
				];
			}

			return h(
				DialogShell,
				{ title: title, description: description, closeLabel: t("close"), onClose: close, dismissible: !view.running, footer: footer },
				scopeRow,
				statusBlock,
				startError === null ? null : h("p", { className: "dshcg-banner", "data-tone": "bad" }, startError),
				notes,
				banner,
				LogPanel({
					view: view,
					heading: t("log.heading"),
					emptyLabel: t("log.empty"),
					truncatedLabel: t("log.truncated")
				})
			);
		}

		/** Services this half needs; the rest is reached through the slot system. */
		var inject = ["slots", "locale", "connection", "contextMenus"];

		/**
		 * Register the dictionaries, the two menu rows, the keyed icons and the
		 * overlay dialog.
		 *
		 * @param {object} ctx - Client root context.
		 * @returns {void}
		 */
		function apply(ctx) {
			var request = createStore(null);
			var t = ctx.locale.bind(NS);
			var open = function open(next) {
				request.set(next);
			};

			ctx.effect(installStyles, "codegraph: dialog styles");
			ctx.effect(function registerLocale() {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "codegraph: dictionaries");

			ctx.slots.inject("contextMenu.icon", function* icons() {
				yield ctx.slots.register({ name: "contextMenu.icon", key: "codegraph.install" }, IconInstall);
				yield ctx.slots.register({ name: "contextMenu.icon", key: "codegraph.uninstall" }, IconUninstall);
			});

			ctx.effect(function registerInstall() {
				return ctx.contextMenus.register({
					id: "codegraph.install",
					target: "workspace",
					order: 240,
					resolve: function resolve(target) {
						return [{
							id: "install",
							label: t("menu.install"),
							icon: { key: "codegraph.install" },
							separatorBefore: true,
							run: function run() {
								open({ action: "install", workspaceId: target.workspaceId, path: target.path, displayTitle: target.displayTitle });
							}
						}];
					}
				});
			}, "codegraph: install menu action");

			ctx.effect(function registerUninstall() {
				return ctx.contextMenus.register({
					id: "codegraph.uninstall",
					target: "workspace",
					order: 250,
					resolve: function resolve(target) {
						return [{
							id: "uninstall",
							label: t("menu.uninstall"),
							icon: { key: "codegraph.uninstall" },
							run: function run() {
								open({ action: "uninstall", workspaceId: target.workspaceId, path: target.path, displayTitle: target.displayTitle });
							}
						}];
					}
				});
			}, "codegraph: uninstall menu action");

			ctx.slots.inject("shell.overlay", function overlay() {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-codegraph-init",
					locale: NS,
					inject: function injected() {
						return {
							hooks: { codegraphRequest: request },
							settleCodegraphRequest: function settle() {
								request.set(null);
							},
							getStatus: function getStatus() {
								return callHost(ctx, "status", {});
							},
							startRun: function startRun(body) {
								return callHost(ctx, "start", body);
							},
							pollRun: function pollRun(id, after) {
								return callHost(ctx, "poll", { runId: id, after: after });
							},
							cancelRun: function cancelRun(id) {
								return callHost(ctx, "cancel", { runId: id });
							},
							forgetRun: function forgetRun(id) {
								return callHost(ctx, "forget", { runId: id });
							}
						};
					}
				}, CodegraphDialog);
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
