window.__ModuleLoader__.load({
	id: "dsh-whale-pal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		let react = require("react");

		//#region 路由与固定文案

		const SECTION_SLOT = "settings.section";
		const SECTION_ID = "whale-pal";
		const SECTION_LABEL = "鲸鲸";
		const SECTION_ORDER = 40;

		/*
		 * 文档相对路径：GUI 页面带 <base href="./">，根绝对路径会逃出子路径前缀。
		 * 客户端和宿主之间只有 HTTP 这一条路。
		 */
		const STATUS_ROUTE = "api/whale-pal/status";
		const SETTINGS_ROUTE = "api/whale-pal/settings";
		const PICK_ROUTE = "api/whale-pal/pick";
		const CARD_PARSE_ROUTE = "api/whale-pal/card/parse";
		const CARD_SPLIT_ROUTE = "api/whale-pal/card/split";
		const WORKSPACES_ROUTE = "api/whale-pal/workspaces";
		const SCENE_ROUTE = "api/whale-pal/scene";

		/** 空值统一口径。 */
		const EMPTY = "还没写 · 想起来再说";

		/** 宿主收的键：五个设施项 + 一个称呼开关 + 人格卡十一项 + 原文存档。多一个都会退回来。 */
		const ALLOWED_KEYS = [
			"vaultPath",
			"workRoot",
			"obsidianEnabled",
			"personaEnabled",
			"rejectServileAddress",
			"whaleWorkspaces",
			"name",
			"nameMeaning",
			"selfName",
			"selfNameMeaning",
			"title",
			"titleMeaning",
			"temperament",
			"values",
			"boundaries",
			"language",
			"summary",
			"personaCard"
		];

		/**
		 * 这次请求的控制参数：不是配置项，不写进盘，宿主那边会摘掉。
		 * 与 ALLOWED_KEYS 分开，是因为那份名单要和 settings.js 的白名单逐字对齐，
		 * 不能掺「只影响本次动作」的开关。
		 */
		const CONTROL_KEYS = ["migrateVault"];

		/**
		 * 工作区那一块的文案。客户端跟宿主不共享模块，这里自己写一份 ——
		 * 只写界面用得到的，报错文案还在 ERROR_COPY 里。
		 */
		const WORKSPACE_COPY = {
			label: "鲸鲸工作区",
			manualLabel: "手动填路径",
			empty: "还没选。挑一个目录当聊天的地儿，或者手动填路径",
			unreadable: "读不到工作区列表，可以在下面手动填一个路径",
			/** 候选一律收进下拉：工作区再多也只占一行。 */
			pick: "挑一个工作区…",
			allAdded: "宿主认识的工作区都加进来了",
			add: "加入",
			remove: "移出",
			placeholder: "例如 D:\\AI 项目\\我的项目"
		};

		/**
		 * 契约里 identity 缺位时也要有骨架，十一项一律按可填算、值走空值口径。
		 * multiline 决定用输入框还是文本域：边界常常是一串条目，单行装不下。
		 */
		const IDENTITY_FALLBACK = [
			{ key: "name", label: "名称", value: "", writable: true, multiline: false },
			{ key: "nameMeaning", label: "名称的含义", value: "", writable: true, multiline: false },
			{ key: "selfName", label: "自称", value: "", writable: true, multiline: false },
			{ key: "selfNameMeaning", label: "自称的含义", value: "", writable: true, multiline: false },
			{ key: "title", label: "称呼", value: "", writable: true, multiline: false },
			{ key: "titleMeaning", label: "称呼的含义", value: "", writable: true, multiline: false },
			{ key: "temperament", label: "底色", value: "", writable: true, multiline: true },
			{ key: "values", label: "价值观", value: "", writable: true, multiline: true },
			{ key: "boundaries", label: "边界", value: "", writable: true, multiline: true },
			{ key: "language", label: "说话风格", value: "", writable: true, multiline: true },
			{ key: "summary", label: "总结", value: "", writable: true, multiline: true }
		];

		/** 宿主错误码到人话的对照。 */
		const ERROR_COPY = {
			"vaultPath-not-a-directory": "这个目录不存在，我不知道你的笔记在哪",
			"vaultPath-not-absolute": "这个路径没从盘符或根目录开始，我看不懂",
			"workRoot-not-a-directory": "这个目录不存在，我不知道任务工作区该建在哪",
			"workRoot-not-absolute": "这个路径没从盘符或根目录开始，我看不懂",
			"workRoot-no-access": "这个目录我打不开，权限不让",
			"obsidianEnabled-not-boolean": "这个开关只认开和关，别的值我没存",
			"personaEnabled-not-boolean": "人格开关只认开和关，别的值我没存",
			"rejectServileAddress-not-boolean": "称呼那个开关只认开和关，别的值我没存",
			"whaleWorkspaces-not-array": "工作区名单得是一个列表，我没存",
			"whaleWorkspaces-not-string": "名单里有一项不是路径，我没存",
			"whaleWorkspace-too-long": "这个路径太长，我不敢截断",
			"whaleWorkspaces-too-many": "鲸鲸工作区最多 20 个，减掉几个再存",
			"field-not-writable": "这一项已经填过，要改就在对话里说",
			"identity-too-long": "这段太长，我存不下",
			"card-field-too-long": "这一项超过上限了，我存不下",
			"personaCard-too-long": "这段太长，原文存不下",
			"body-not-json": "这段内容不是 JSON，我没动设置",
			"key-not-allowed": "这个键不在我能改的范围里，我没动它"
		};

		//#endregion

		//#region 小工具

		function isObject(value) {
			if (value === null || value === undefined) return false;
			return typeof value === "object" && Array.isArray(value) === false;
		}

		function plain(value) {
			if (typeof value === "string") return value;
			if (typeof value === "number" && Number.isFinite(value)) return String(value);
			if (typeof value === "boolean") return value ? "开" : "关";
			return "";
		}

		/** 任何展示值：空字符串、null、缺失都落到 EMPTY。 */
		function textOf(value) {
			const shown = plain(value);
			return shown === "" ? EMPTY : shown;
		}

		/** 从 {value, placeholder} 之类的字段里取字符串值。 */
		function valueOf(field) {
			if (isObject(field) === false) return "";
			return plain(field.value);
		}

		function placeholderOf(field, fallback) {
			if (isObject(field) === true) {
				const given = plain(field.placeholder);
				if (given.length > 0) return given;
			}
			return fallback;
		}

		function fieldOf(data, key) {
			const editable = isObject(data) && isObject(data.editable) ? data.editable : {};
			return isObject(editable[key]) ? editable[key] : {};
		}

		/**
		 * 目录比较口径：跟宿主 workspaceKey 对齐（分隔符、尾斜杠、大小写）。
		 * 页面这边不知道平台，统一按 Windows 的宽松口径比 —— 只会更不容易认错。
		 */
		function normPath(value) {
			if (typeof value !== "string") return "";
			return value.trim().replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
		}

		/** 保存成功后把本地快照里的那一项一并更新，省得整页重读。 */
		function withPatch(data, patch) {
			if (isObject(data) === false) return data;
			const editable = isObject(data.editable) ? data.editable : {};
			const nextEditable = {};
			for (const key of Object.keys(editable)) nextEditable[key] = editable[key];
			for (const key of Object.keys(patch)) {
				const previous = isObject(nextEditable[key]) ? nextEditable[key] : {};
				const next = {};
				for (const inner of Object.keys(previous)) next[inner] = previous[inner];
				next.value = patch[key];
				nextEditable[key] = next;
			}
			const next = {};
			for (const key of Object.keys(data)) next[key] = data[key];
			next.editable = nextEditable;
			return next;
		}

		function readStatusError(payload, status) {
			if (status === 404) return "宿主那边还没有这个接口，设置读不出来";
			if (status === 403) return "宿主没让我读这份设置";
			const message = isObject(payload) === true ? plain(payload.message) : "";
			if (message.length > 0) return message;
			const code = isObject(payload) === true ? plain(payload.error) : "";
			if (code.length > 0) return "我没读到设置，宿主退回的是 " + code;
			return "我没读到设置，宿主回的状态是 " + String(status);
		}

		function readWriteError(payload, status) {
			// 宿主会把给人看的那句话一起带回来，有就用它，别让两边各写一份文案。
			const message = isObject(payload) === true ? plain(payload.message) : "";
			if (message.length > 0) return message;
			const code = isObject(payload) === true ? plain(payload.error) : "";
			if (code.length > 0 && Object.prototype.hasOwnProperty.call(ERROR_COPY, code)) return ERROR_COPY[code];
			if (status === 403) return "这个键我没权限改，设置没有动";
			if (code.length > 0) return "我没存成，宿主退回的是 " + code;
			return "我没存成，宿主回的状态是 " + String(status);
		}

		//#endregion

		//#region 接口

		async function fetchStatus() {
			let response;
			try {
				response = await fetch(STATUS_ROUTE, { headers: { accept: "application/json" } });
			} catch (error) {
				return { ok: false, message: "这个页面没连上宿主，我不知道现在的设置是什么" };
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			if (response.ok === false) return { ok: false, message: readStatusError(payload, response.status) };
			if (isObject(payload) === false) return { ok: false, message: "宿主回的是一段我看不懂的东西，设置读不出来" };
			if (payload.ok === false) return { ok: false, message: readStatusError(payload, response.status) };
			return { ok: true, data: payload };
		}

		/**
		 * 宿主认识的工作区清单，给「鲸鲸工作区」那一块当候选。
		 * 读不到就回空数组，不报错 —— 页面还有手动填路径这条兜底。
		 */
		async function fetchWorkspaces() {
			let response;
			try {
				response = await fetch(WORKSPACES_ROUTE, { headers: { accept: "application/json" } });
			} catch (error) {
				return [];
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			if (response.ok === false || isObject(payload) === false) return [];
			const list = Array.isArray(payload.workspaces) ? payload.workspaces : [];
			return list.filter(isObject);
		}

		async function postSettings(patch, controls) {
			const body = {};
			for (const key of ALLOWED_KEYS) {
				if (Object.prototype.hasOwnProperty.call(patch, key)) body[key] = patch[key];
			}
			// 控制参数单独并进去：白名单只认配置键，这类开关不进那份名单。
			if (isObject(controls)) {
				for (const key of CONTROL_KEYS) {
					if (Object.prototype.hasOwnProperty.call(controls, key)) body[key] = controls[key];
				}
			}
			let response;
			try {
				response = await fetch(SETTINGS_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
			} catch (error) {
				return { ok: false, message: "这个页面没连上宿主，这项没存下" };
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			if (response.ok === false) return { ok: false, message: readWriteError(payload, response.status) };
			if (isObject(payload) === false) return { ok: false, message: "宿主回的是一段我看不懂的东西，这项没存下" };
			if (payload.ok === false) return { ok: false, message: readWriteError(payload, response.status) };
			const warnings = Array.isArray(payload.warnings)
				? payload.warnings.filter((item) => typeof item === "string" && item.length > 0)
				: [];
			const applied = Array.isArray(payload.applied)
				? payload.applied.filter((item) => typeof item === "string" && item.length > 0)
				: [];
			// 换库时搬了什么：形状不对就当没搬，不让页面上出现半截清单。
			const migrated = isObject(payload.migrated) && Array.isArray(payload.migrated.moved) ? payload.migrated : null;
			return { ok: true, warnings, applied, migrated };
		}

		/**
		 * 把整段原文丢给宿主拆一次。不写盘，只回结果。
		 *
		 * 规则拆分与模型拆分共用这一条通道，区别只有路由：规则那条免费，
		 * 模型那条花的是真钱，所以只有按钮能触发，绝不自动跑。
		 */
		async function postCard(route, raw) {
			let response;
			try {
				response = await fetch(route, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ raw })
				});
			} catch (error) {
				return { ok: false, message: "这个页面没连上宿主，这次没拆" };
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			if (response.ok === false) return { ok: false, message: readWriteError(payload, response.status) };
			if (isObject(payload) === false) return { ok: false, message: "宿主回的是一段我看不懂的东西，这次没拆" };
			if (payload.ok === false) return { ok: false, message: readWriteError(payload, response.status) };
			return { ok: true, data: payload };
		}

		/**
		 * 记忆分层的四个动作：挪一条记忆、把目录并到项目、改场景名、决定那条「通用层满了」的请求。
		 * 走一条独立路由：它不是配置，改的是状态（和 /settings 的白名单不是一回事）。
		 */
		async function postScene(action) {
			let response;
			try {
				response = await fetch(SCENE_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(isObject(action) ? action : {})
				});
			} catch (error) {
				return { ok: false, message: "这个页面没连上宿主，这次没动" };
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			if (response.ok === false) return { ok: false, message: readWriteError(payload, response.status) };
			if (isObject(payload) === false) return { ok: false, message: "宿主回的是一段我看不懂的东西，这次没动" };
			if (payload.ok === false) return { ok: false, message: readWriteError(payload, response.status) };
			return { ok: true, data: payload };
		}

		/**
		 * 让宿主弹一个目录选择窗口。
		 *
		 * 选到就回路径；用户自己关掉窗口回 path: null（不是错）；
		 * 宿主那边没 compose 出原生窗口就回 503，message 直接用宿主给的那句。
		 */
		async function pickFolder() {
			let response;
			try {
				response = await fetch(PICK_ROUTE, {
					method: "POST",
					headers: { accept: "application/json" }
				});
			} catch (error) {
				return { ok: false, message: "这个页面没连上宿主，选不了目录" };
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			if (response.ok === false) return { ok: false, message: readWriteError(payload, response.status) };
			if (isObject(payload) === false) return { ok: false, message: "宿主回的是一段我看不懂的东西，路径没动" };
			if (payload.ok === false) return { ok: false, message: readWriteError(payload, response.status) };
			const path = plain(payload.path);
			return { ok: true, path: path.length > 0 ? path : null };
		}

		//#endregion

		//#region 样式

		const S = {
			page: {
				display: "flex",
				flexDirection: "column",
				gap: "16px",
				padding: "4px 2px 24px",
				fontSize: "13px",
				lineHeight: 1.65,
				color: "inherit"
			},
			title: { margin: 0, fontSize: "15px", fontWeight: 600 },
			lead: { margin: 0, opacity: 0.7 },
			group: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				padding: "13px 15px",
				border: "1px solid rgba(128,128,128,0.28)",
				borderRadius: "10px"
			},
			groupTitle: { margin: 0, fontSize: "13px", fontWeight: 600 },
			groupLead: { margin: 0, opacity: 0.66 },
			row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" },
			label: { minWidth: "86px", opacity: 0.8 },
			value: { flex: "1 1 160px", wordBreak: "break-all" },
			hint: { flexBasis: "100%", opacity: 0.58, fontSize: "12px" },
			/** 跟标签同一行的一句话：不吃满整行，也不抢下拉的位置。 */
			note: { flex: "1 1 220px", opacity: 0.58, fontSize: "12px" },
			input: {
				flex: "1 1 220px",
				minWidth: "170px",
				padding: "6px 9px",
				borderRadius: "7px",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "transparent",
				color: "inherit",
				fontSize: "13px",
				fontFamily: "inherit"
			},
			select: {
				/** 原生 select 的固有宽度跟最长那一项走，不压住就把右边的按钮顶出框。
				 *  基宽给 0 再吃满剩余空间，超出的文字由控件自己截。 */
				flex: "1 1 0",
				width: 0,
				minWidth: 0,
				maxWidth: "100%",
				padding: "6px 9px",
				borderRadius: "7px",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "transparent",
				color: "inherit",
				fontSize: "13px",
				fontFamily: "inherit"
			},
			button: {
				padding: "5px 12px",
				borderRadius: "7px",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "transparent",
				color: "inherit",
				fontSize: "13px",
				fontFamily: "inherit",
				cursor: "pointer"
			},
			noticeError: {
				margin: 0,
				padding: "9px 11px",
				borderRadius: "8px",
				border: "1px solid rgba(200,90,80,0.5)",
				background: "rgba(200,90,80,0.1)"
			},
			/** 动作结果贴在视口底部：长页面上，提示离按钮近了才看得见。 */
			toast: {
				position: "fixed",
				left: "50%",
				bottom: "22px",
				transform: "translateX(-50%)",
				zIndex: 80,
				maxWidth: "min(560px, 86vw)",
				margin: 0,
				padding: "10px 14px",
				borderRadius: "10px",
				border: "1px solid rgba(128,128,128,0.35)",
				background: "rgba(30,30,32,0.94)",
				color: "#fff",
				boxShadow: "0 8px 28px rgba(0,0,0,0.3)",
				fontSize: "13px",
				lineHeight: 1.5,
				pointerEvents: "none"
			},
			toastError: {
				position: "fixed",
				left: "50%",
				bottom: "22px",
				transform: "translateX(-50%)",
				zIndex: 80,
				maxWidth: "min(560px, 86vw)",
				margin: 0,
				padding: "10px 14px",
				borderRadius: "10px",
				border: "1px solid rgba(220,110,100,0.6)",
				background: "rgba(70,26,24,0.95)",
				color: "#fff",
				boxShadow: "0 8px 28px rgba(0,0,0,0.3)",
				fontSize: "13px",
				lineHeight: 1.5,
				pointerEvents: "none"
			},
			textarea: {
				/** 块字段和粘贴区都独占一行：和标签、按钮挤在同一行会窄得没法写。 */
				flex: "1 1 100%",
				width: "100%",
				boxSizing: "border-box",
				minHeight: "150px",
				padding: "8px 10px",
				borderRadius: "7px",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "transparent",
				color: "inherit",
				fontSize: "13px",
				fontFamily: "inherit",
				lineHeight: 1.6,
				resize: "vertical"
			},
			/** 那四个块（底色 / 价值观 / 边界 / 说话风格）矮一截：
			 *  平时就几行字，撑到 150px 白占地方；要写长了还能自己往下拽。 */
			blockTextarea: {
				flex: "1 1 100%",
				width: "100%",
				boxSizing: "border-box",
				minHeight: "84px",
				padding: "8px 10px",
				borderRadius: "7px",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "transparent",
				color: "inherit",
				fontSize: "13px",
				fontFamily: "inherit",
				lineHeight: 1.6,
				resize: "vertical"
			},
			/** 其余块：原样显示没归类的那几行，长了自己滚。 */
			pre: {
				margin: 0,
				padding: "8px 10px",
				borderRadius: "7px",
				background: "rgba(128,128,128,0.08)",
				fontSize: "12px",
				fontFamily: "inherit",
				lineHeight: 1.6,
				whiteSpace: "pre-wrap",
				wordBreak: "break-all",
				maxHeight: "160px",
				overflow: "auto"
			},
			/** 十一项围在一个框里：它们是一张卡上的格子，不该散成十条独立设置。 */
			cardBox: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				padding: "11px 13px",
				border: "1px solid rgba(128,128,128,0.22)",
				borderRadius: "9px"
			},
			empty: { margin: 0, opacity: 0.58, fontSize: "12px" },
			/** 没进十一项的段落：折叠着放，免得一大段原文把设置页撑成阅读器。 */
			sectionHead: { cursor: "pointer", opacity: 0.8, fontSize: "12px" }
		};

		//#endregion

		//#region 设置页

		function rowElement(key, label, valueNode, hint) {
			const children = [
				react.createElement("span", { key: "label", style: S.label }, label),
				react.createElement("span", { key: "value", style: S.value }, valueNode)
			];
			if (typeof hint === "string" && hint.length > 0) {
				children.push(react.createElement("span", { key: "hint", style: S.hint }, hint));
			}
			return react.createElement("div", { key: key, style: S.row }, children);
		}

		function groupElement(key, title, lead, children) {
			const nodes = [react.createElement("h3", { key: "title", style: S.groupTitle }, title)];
			if (typeof lead === "string" && lead.length > 0) {
				nodes.push(react.createElement("p", { key: "lead", style: S.groupLead }, lead));
			}
			for (let index = 0; index < children.length; index += 1) {
				const child = children[index];
				if (child === null || child === undefined) continue;
				nodes.push(child);
			}
			return react.createElement("section", { key: key, style: S.group }, nodes);
		}

		function emptyLine(key, value) {
			return react.createElement("p", { key: key, style: S.empty }, value);
		}

		/**
		 * 鲸鲸的设置页。ownerProps 只给 close，这里不接管关闭，对话框自己收。
		 */
		function WhalePalSection(props) {
			const [snapshot, setSnapshot] = react.useState({ phase: "loading", data: null, message: "" });
			const [draft, setDraft] = react.useState({ vaultPath: "", workRoot: "" });
			/** 换库时要不要把旧库的台账和上下文复制过来：默认要，取消勾选就只改指向。 */
			const [moveOnSwitch, setMoveOnSwitch] = react.useState(true);
			/** 粘贴区的原文，以及拆出来的十一项草稿（没写入前只在本页活着）。 */
			const [cardRaw, setCardRaw] = react.useState("");
			const [cardDraft, setCardDraft] = react.useState({});
			/** 没进十一项的段落：[{title, heading, text, chars, movedTo}]，只在本页显示，不进内核。 */
			const [cardSections, setCardSections] = react.useState([]);
			/** 模型那条自己交代的账：哪一段搬进了哪一项、哪一段没搬进去。 */
			const [cardMoves, setCardMoves] = react.useState([]);
			const [cardUnused, setCardUnused] = react.useState([]);
			const [cardNote, setCardNote] = react.useState("");
			const [notice, setNotice] = react.useState({ kind: "", text: "" });
			const [busy, setBusy] = react.useState(false);
			/** 宿主那边的工作区清单、下拉里挑中的那一条，以及手动填路径的草稿。 */
			const [workspaces, setWorkspaces] = react.useState([]);
			const [workspaceChoice, setWorkspaceChoice] = react.useState("");
			const [workspaceInput, setWorkspaceInput] = react.useState("");
			/** 记忆分层：要挪的那条、挪去哪、要并进项目的目录。 */
			const [sceneDraft, setSceneDraft] = react.useState({ id: "", target: "", dir: "", project: "" });

			const seed = (data) => ({
				vaultPath: valueOf(fieldOf(data, "vaultPath")),
				workRoot: valueOf(fieldOf(data, "workRoot"))
			});

			const reload = () => {
				setNotice({ kind: "", text: "" });
				setSnapshot({ phase: "loading", data: null, message: "" });
				// 重读就是「以盘上为准」：还没写进去的草稿一并丢掉，免得看着像存过了。
				setCardDraft({});
				setCardSections([]);
				setCardMoves([]);
				setCardUnused([]);
				setCardNote("");
				// 工作区清单不挡主状态：读不到就只是少一份候选，页面还有手填那条路。
				setWorkspaceChoice("");
				fetchWorkspaces().then((list) => setWorkspaces(list));
				return fetchStatus().then((result) => {
					if (result.ok === false) {
						setSnapshot({ phase: "error", data: null, message: result.message });
						return;
					}
					setSnapshot({ phase: "ready", data: result.data, message: "" });
					setDraft(seed(result.data));
					// 存档里的那几段也摆出来：不点「拆一下」也看得见自己当初写了什么、哪些没进内核。
					setCardSections(sectionsOf(isObject(result.data) && isObject(result.data.card) ? result.data.card : {}));
				});
			};

			react.useEffect(() => {
				reload();
			}, []);

			const save = (patch, doneCopy, controls) => {				setBusy(true);
				setNotice({ kind: "", text: "" });
				return postSettings(patch, controls).then((result) => {
					setBusy(false);
					if (result.ok === true) {
						const extra = result.warnings.length > 0 ? "。宿主另外说：" + result.warnings.join("；") : "";
						// 换库时后端会把台账和上下文复制过来；旧库是复制源，不动它。
						const moved = result.migrated && result.migrated.moved && result.migrated.moved.length > 0
							? "。台账和上下文搬过来了（" + result.migrated.total.files + " 个文件），旧库还在原地"
							: "";
						// 换总路径只换指向、不搬任何文件；指挥部跟着新路径固定建一个。
						// 两句都只在真的发生时才说，没换路径的人不用看。
						const rootMoved = result.workRootMoved
							? "。工作区总路径换了，旧目录里的文件不会跟着搬，还是留在原处"
							: "";
						const chief = result.chief
							? (result.chief.ok === true
								? "。指挥部工作区已经在（" + result.chief.path + "）"
								: "。指挥部工作区没建成：" + result.chief.message)
							: "";
						setNotice({ kind: "ok", text: doneCopy + moved + rootMoved + chief + extra });
						setSnapshot((previous) => {
							if (previous.phase === "ready") {
								return { phase: "ready", data: withPatch(previous.data, patch), message: "" };
							}
							return previous;
						});
						return;
					}
					setNotice({ kind: "error", text: result.message });
				});
			};

			/**
			 * 改鲸鲸工作区名单。整张名单一起发 —— 宿主那边是覆盖式保存，
			 * 发半张会把别的目录悄悄抹掉。
			 */
			const saveWhaleWorkspaces = (list, verb) => save({ whaleWorkspaces: list }, "工作区" + verb + "了");

			/** 记忆分层的动作：挪一条、并一个目录、决定一条请求。做完整页重读，不在这边猜结果。 */
			const runSceneAction = (action, doneCopy) => {
				setBusy(true);
				setNotice({ kind: "", text: "" });
				return postScene(action).then((result) => {
					setBusy(false);
					if (result.ok === false) {
						setNotice({ kind: "error", text: result.message });
						return;
					}
					return reload().then(() => setNotice({ kind: "ok", text: doneCopy }));
				});
			};

			// 选目录只有一个入口，但要能填两个格：笔记库和工作区总路径。
			// 不传参就是笔记库（老调用点不用改），传 "workRoot" 就填派活那格。
			const pick = (target = "vaultPath") => {
				setBusy(true);
				setNotice({ kind: "", text: "" });
				return pickFolder().then((result) => {
					setBusy(false);
					if (result.ok === false) {
						setNotice({ kind: "error", text: result.message });
						return;
					}
					if (result.path === null) {
						setNotice({ kind: "", text: "没选，路径没变" });
						return;
					}
					if (target === "workRoot") {
						setDraft({ ...draft, workRoot: result.path });
						return save({ workRoot: result.path }, "工作区总路径存下了");
					}
					setDraft({ ...draft, vaultPath: result.path });
					const controls = moveOnSwitch === false ? { migrateVault: false } : null;
					return save({ vaultPath: result.path }, "路径存下了", controls);
				});
			};

			/** 填一格身份：写成功后整页重读，别在本地猜只读状态。 */
			const writeIdentity = (key, value) => {
				setBusy(true);
				setNotice({ kind: "", text: "" });
				const patch = {};
				patch[key] = value;
				return postSettings(patch).then((result) => {
					setBusy(false);
					if (result.ok === true) {
						// reload 自己会清提示，所以记下这句话要等重读回来再说。
						// 清空也是改：回一句「清空了」，别让人以为按钮没起作用。
						return reload().then(() =>
							setNotice({ kind: "ok", text: value.trim() === "" ? "清空了" : "记下了" })
						);
					}
					setNotice({ kind: "error", text: result.message });
				});
			};

			/** 改草稿里的一格：草稿只在写入前活在页面上。 */
			const setCardField = (key, value) => {
				const next = {};
				for (const inner of Object.keys(cardDraft)) next[inner] = cardDraft[inner];
				next[key] = value;
				setCardDraft(next);
			};

			/**
			 * 拆解结果里的「没进十一项的部分」。
			 *
			 * 新宿主直接给 sections；老宿主只有 rest，就把它整段当成一段，别让它凭空消失。
			 * 一条正文都没有的空段丢掉：界面上留一个点开是空的折叠条目只会让人以为坏了。
			 */
			function sectionsOf(data) {
				const list = Array.isArray(data.sections) ? data.sections : [];
				const clean = list
					.map((item) => ({
						title: plain(item && item.title),
						heading: plain(item && item.heading),
						text: plain(item && item.text),
						chars: Number(item && item.chars) || 0
					}))
					.filter((item) => item.text !== "" || item.heading !== "");
				if (clean.length > 0) return clean;
				const rest = plain(data.rest);
				return rest === "" ? [] : [{ title: "", heading: "", text: rest, chars: rest.length }];
			}

			/**
			 * 模型交代的账：哪一段搬进了哪一项、哪一段没搬进去。
			 *
			 * 这些是给人核对用的，不是权威——所以只认字符串、认不出的直接丢。
			 * from 对不上段标题的也留着（模型可能写了半句原话），界面上当一条记录显示。
			 */
			function movesOf(data) {
				const list = Array.isArray(data) ? data : [];
				return list
					.map((item) => ({ from: plain(item && item.from), to: plain(item && item.to) }))
					.filter((item) => item.from !== "" && item.to !== "");
			}

			function unusedOf(data) {
				const list = Array.isArray(data) ? data : [];
				return list
					.map((item) => ({ from: plain(item && item.from), why: plain(item && item.why) }))
					.filter((item) => item.from !== "");
			}

			/**
			 * 把模型的账贴回段落上：搬走的那几段，界面上要看得出来是进了哪一项。
			 *
			 * 先认全等，再认互相包含——模型抄标题时常多带半个字、少带一个「的」。
			 * 认不出就保持原样，宁可显示「没进内核」也不假装它搬过。
			 */
			function markMoved(sections, moves) {
				if (moves.length === 0) return sections;
				const find = (item) => {
					const title = plain(item.title);
					if (title === "") return null;
					for (const move of moves) {
						if (move.from === title) return move;
						if (move.from.length >= 2 && title.length >= 2 && (move.from.indexOf(title) >= 0 || title.indexOf(move.from) >= 0)) {
							return move;
						}
					}
					return null;
				};
				return sections.map((item) => {
					const move = find(item);
					if (move === null) return item;
					return { title: item.title, heading: item.heading, text: item.text, chars: item.chars, movedTo: move.to };
				});
			}

			/**
			 * 拆一次。规则那条免费、即时，只切段认标签；模型那条只在人点了才跑，
			 * 它会把落空的段落压进十一项，并交代每段去了哪。
			 * 两条路都只填草稿，不写盘——写要等「全部写进去」。
			 */
			const splitCard = (route) => {
				const raw = cardRaw.trim();
				if (raw === "") {
					setCardNote("还没粘进来内容");
					return;
				}
				setBusy(true);
				setCardNote("");
				setNotice({ kind: "", text: "" });
				return postCard(route, cardRaw).then((result) => {
					setBusy(false);
					if (result.ok === false) {
						setCardNote(result.message);
						return;
					}
					const fields = isObject(result.data.fields) ? result.data.fields : {};
					const hits = Array.isArray(result.data.hits) ? result.data.hits : [];
					const moves = movesOf(result.data.moves);
					const unused = unusedOf(result.data.unused);
					const sections = markMoved(sectionsOf(result.data), moves);
					const next = {};
					for (const inner of Object.keys(cardDraft)) next[inner] = cardDraft[inner];
					for (const key of Object.keys(fields)) {
						if (typeof fields[key] === "string" && fields[key] !== "") next[key] = fields[key];
					}
					// 模型跳过一项，不等于原文没写这一项：规则拆只按标题认标签，认出来的
					// 是这份原文自己的结构。拆一次就以这次的结果为准——草稿里先前填的
					// （人打的、上一轮拆的）都算旧值，不许挡住这次拆出来的内容。
					const ruleFields = isObject(result.data.ruleFields) ? result.data.ruleFields : {};
					const fromRule = [];
					if (route === CARD_SPLIT_ROUTE) {
						for (const entry of identityRows) {
							const key = plain(entry && entry.key);
							if (key === "") continue;
							if (Object.prototype.hasOwnProperty.call(fields, key)) continue;
							const value = typeof ruleFields[key] === "string" ? ruleFields[key] : "";
							if (value.trim() === "") continue;
							next[key] = value;
							fromRule.push(key);
						}
					}
					// 边界里原文没有的句子是人自己加的，这次按原文重写会把它盖掉。
					// 不偷偷接回去（上一版就是这么干的，把人刚填的内容又贴回来了），
					// 只说一句盖掉了什么，要不要写回去由人决定。
					const boundEntry = identityRows.find((entry) => plain(entry && entry.key) === "boundaries");
					const storedBounds = boundEntry ? plain(boundEntry.value) : "";
					let droppedBounds = 0;
					if (
						route === CARD_SPLIT_ROUTE &&
						!Object.prototype.hasOwnProperty.call(cardDraft, "boundaries") &&
						storedBounds.trim() !== "" &&
						typeof next.boundaries === "string" &&
						next.boundaries.trim() !== ""
					) {
						droppedBounds = storedBounds
							.split(/\n+/)
							.map((line) => line.trim())
							.filter((line) => line !== "")
							.filter((line) => cardRaw.indexOf(line.replace(/^[-*•·\d.、\s]+/, "")) === -1)
							.filter((line) => next.boundaries.indexOf(line) === -1).length;
					}
					setCardDraft(next);
					setCardSections(sections);
					setCardMoves(moves);
					setCardUnused(unused);
					// 搬进十一项的那几段不再算「没进内核」——账要按段落实际去向算，
					// 否则模型搬了五段，界面上还写着五段都在外面，人分不清它到底动了没有。
					const left = sections.filter((item) => typeof item.movedTo !== "string" || item.movedTo === "");
					const movedCount = sections.length - left.length;
					const leftChars = left.reduce((sum, item) => sum + item.chars, 0);
					const kept =
						left.length === 0
							? ""
							: "另有 " + String(left.length) + " 段（" + String(leftChars) + " 字）没进内核，原样留着";
					const movedCopy = movedCount === 0 ? "" : "模型把 " + String(movedCount) + " 段搬进了十一项";
					const unusedCopy = unused.length === 0 ? "" : String(unused.length) + " 段没归进十一项";
					// 模型没回的项由规则补上时，补了哪几项要说出来：那是规则按标题认的，
					// 不是模型的意思，人对这两者的信任度不一样。
					const fromRuleCopy =
						fromRule.length === 0
							? ""
							: "模型没回 " + fromRule.map(fieldLabel).join("、") + "，按规则拆的";
					const droppedBoundsCopy =
						droppedBounds === 0
							? ""
							: "边界原来那 " + String(droppedBounds) + " 句原文里没有，这次按原文重写了";
					const hitCount = new Set(hits.concat(fromRule)).size;
					const tailOf = (parts) => parts.filter((item) => item !== "").join("；");
					if (hitCount === 0) {
						setCardNote(
							route === CARD_SPLIT_ROUTE
								? tailOf(["模型也没拆出能归到十一项的内容", kept, "十一项要手填"])
								: "这一段里我没认出标签，一行都没归到十一项里；要么补上「名称：」「价值观：」这类标签，要么点「让模型帮我拆」"
						);
						return;
					}
					// 认出一两项、底下还挂着段落：多半是这份写法没吃准，给出下一步。
					// 模型那条不再劝它自己一遍——它已经尽力了，再劝是死循环。
					if (route === CARD_PARSE_ROUTE && hits.length <= 2 && sections.length > 0) {
						setCardNote(
							"只认出 " + String(hits.length) + " 项，" + kept + "。这份写法我没吃准，点「让模型帮我拆」试试"
						);
						return;
					}
					setCardNote(
						tailOf([
							"拆出 " + String(hitCount) + " 项",
							movedCopy,
							kept,
							unusedCopy,
							fromRuleCopy,
							droppedBoundsCopy
						]) + "；改完点「全部写进去」"
					);
				});
			};

			/** 把草稿里改过的项一次写完（含清空），原文一起存档。 */
			const applyCardAll = () => {
				// 盘上现在是什么：空白只对「本来有值、现在清掉」才算改动，
				// 空对空不发，免得把没碰过的项也当成清空写一遍。
				const storedOf = {};
				for (const entry of identityRows) {
					if (isObject(entry)) storedOf[plain(entry.key)] = plain(entry.value);
				}
				const patch = {};
				let count = 0;
				for (const key of Object.keys(cardDraft)) {
					const value = typeof cardDraft[key] === "string" ? cardDraft[key] : "";
					const stored = typeof storedOf[key] === "string" ? storedOf[key] : "";
					if (value.trim() === "" && stored.trim() === "") continue;
					patch[key] = value;
					count += 1;
				}
				if (count === 0) {
					setCardNote("十一项都没有改动");
					return;
				}
				if (cardRaw.trim() !== "") patch.personaCard = cardRaw;
				setBusy(true);
				setNotice({ kind: "", text: "" });
				return postSettings(patch).then((result) => {
					setBusy(false);
					if (result.ok === false) {
						setNotice({ kind: "error", text: result.message });
						return;
					}
					return reload().then(() => setNotice({ kind: "ok", text: "写进去了 " + String(result.applied.length) + " 项" }));
				});
			};

			const head = [
				react.createElement("h2", { key: "title", style: S.title }, SECTION_LABEL),
				react.createElement(
					"p",
					{ key: "lead", style: S.lead },
					"名称、自称、称呼各带一个含义，加上底色、价值观、边界、说话风格、总结；十一项随时能改。"
				)
			];

			if (snapshot.phase === "error") {
				return react.createElement("div", { style: S.page }, [
					head[0],
					head[1],
					react.createElement("p", { key: "error", style: S.noticeError }, snapshot.message),
					react.createElement(
						"div",
						{ key: "retry", style: S.row },
						react.createElement("button", { type: "button", style: S.button, onClick: reload }, "再读一次")
					)
				]);
			}

			if (snapshot.phase === "loading") {
				return react.createElement("div", { style: S.page }, [
					head[0],
					head[1],
					react.createElement("p", { key: "loading", style: S.lead }, "在读记录，等一下")
				]);
			}

			const data = snapshot.data;
			const editable = isObject(data) && isObject(data.editable) ? data.editable : {};
			// 宿主没给这一格（旧版本）就当能选，点了再让宿主自己回话。
			const pickerAvailable = isObject(data) && isObject(data.picker)
				? data.picker.available === true
				: true;
			const obsidianField = fieldOf(data, "obsidianEnabled");
			const workspaceField = fieldOf(data, "whaleWorkspaces");
			const obsidianOn = obsidianField.value === true;
			// 人格总开关：老宿主没这一格当「开着」——关着才是要明说的状态。
			const personaField = fieldOf(data, "personaEnabled");
			const personaOn = personaField.value !== false;
			// 称呼上的硬边界：不属于人格卡，是这台机器自己的立场。
			const servileField = fieldOf(data, "rejectServileAddress");
			const servileOn = servileField.value === true;
			// 宿主会告诉我们装没装、接没接；旧宿主没这一格就当不知道，不编。
			const obsidianInfo = isObject(data) && isObject(data.obsidian) ? data.obsidian : null;
			const obsidianLabel = obsidianInfo !== null && typeof obsidianInfo.label === "string" ? obsidianInfo.label : "";
			const obsidianHasVault = obsidianInfo !== null && obsidianInfo.hasVault === true;
			// 鲸鲸名单：页面只负责显示与勾选，写盘仍旧走 POST /settings。
			const whalePaths = Array.isArray(workspaceField.value)
				? workspaceField.value.filter((item) => typeof item === "string" && item !== "")
				: [];
			const whaleKeySet = new Set(whalePaths.map(normPath));
			const accounting = isObject(data) && isObject(data.accounting) ? data.accounting : {};
			const given = Array.isArray(data.identity) ? data.identity.filter(isObject) : [];
			const identityRows = given.length > 0 ? given : IDENTITY_FALLBACK;

			// ---- 记忆分层（P4）：现在在哪一层、有几层、每条为什么在这层、手动挪。
			// 数据全部来自 /status 的 view.scene；旧宿主没这一格就整段不渲染。
			const sceneView = isObject(data) && isObject(data.view) && isObject(data.view.scene) ? data.view.scene : null;
			const scenePools = sceneView !== null && Array.isArray(sceneView.pools) ? sceneView.pools : [];
			const sceneEntries = sceneView !== null && Array.isArray(sceneView.entries) ? sceneView.entries : [];
			const sceneRequests = sceneView !== null && Array.isArray(sceneView.requests) ? sceneView.requests : [];
			const sceneCurrent = sceneView !== null && isObject(sceneView.current) ? sceneView.current : null;
			const sceneNote = sceneView !== null && typeof sceneView.note === "string" ? sceneView.note : "";
			const sceneTotal = sceneView !== null && typeof sceneView.total === "number" ? sceneView.total : sceneEntries.length;
			const poolChoices = scenePools.map((pool) => ({
				value: plain(pool.id),
				label: plain(pool.label) + "（" + textOf(pool.count) + " 条）"
			}));
			const viaWords = {
				manual: "手动指定",
				marker: "按项目标记往上找",
				cwd: "按目录名",
				backup: "备份目录，并到被备份的那个项目",
				unresolved: "没认出来"
			};
			const currentDir = sceneCurrent !== null ? plain(sceneCurrent.cwd) : "";
			const currentSceneId = sceneCurrent !== null ? plain(sceneCurrent.scene) : "";
			const currentVia = sceneCurrent !== null ? viaWords[plain(sceneCurrent.via)] || "" : "";
			const currentPool = scenePools.find((pool) => plain(pool.id) === currentSceneId) || null;
			const currentLabel = currentSceneId === "" ? "没认出来，先落在主人层" : currentPool !== null ? plain(currentPool.label) : currentSceneId;
			const timeText = (value) => {
				const n = Number(value) || 0;
				if (n <= 0) return "";
				const date = new Date(n);
				return isNaN(date.getTime()) ? "" : date.toLocaleString();
			};

			const sceneNodes = [];
			sceneNodes.push(
				react.createElement("div", { key: "scene-now", style: S.row }, [
					react.createElement("span", { key: "label", style: S.label }, "现在在哪"),
					react.createElement("span", { key: "value", style: S.value }, currentDir === "" ? "还没读到目录" : currentDir),
					react.createElement(
						"span",
						{ key: "hint", style: S.hint },
						"归到：" + currentLabel + (currentVia === "" ? "" : "（" + currentVia + "）")
					)
				])
			);
			for (let i = 0; i < scenePools.length; i += 1) {
				const pool = scenePools[i];
				const updated = timeText(pool.lastUpdatedAt);
				sceneNodes.push(
					react.createElement("div", { key: "pool-" + plain(pool.id) + "-" + String(i), style: S.row }, [
						react.createElement("span", { key: "label", style: S.label }, plain(pool.label)),
						react.createElement("span", { key: "value", style: S.value }, textOf(pool.count) + " 条"),
						updated === "" ? null : react.createElement("span", { key: "hint", style: S.hint }, "最后更新 " + updated)
					])
				);
			}
			if (scenePools.length === 0) sceneNodes.push(emptyLine("scene-empty", "还没有记忆，也就还没有分层"));

			// 群（P5）：群记录里那条会话还认不认得。认不出来就是静默降级，这里必须看得见。
			const sceneGroups = sceneView !== null && Array.isArray(sceneView.groups) ? sceneView.groups : [];
			const sceneCheck = sceneView !== null && Array.isArray(sceneView.groupCheck) ? sceneView.groupCheck : [];
			for (let i = 0; i < sceneGroups.length; i += 1) {
				const group = sceneGroups[i];
				const status = sceneCheck.find((item) => plain(item.id) === plain(group.id)) || null;
				const broken = status !== null && status.ok !== true;
				sceneNodes.push(
					react.createElement("div", { key: "group-" + String(i), style: S.row }, [
						react.createElement("span", { key: "label", style: S.label }, plain(group.name) || plain(group.groupId)),
						react.createElement(
							"span",
							{ key: "value", style: S.value },
							plain(group.sessionId) === "" ? "还没有会话" : "会话 " + plain(group.sessionId)
						),
						broken
							? react.createElement(
									"span",
									{ key: "hint", style: S.hint },
									"这条会话认不出来了，群记忆正在退化成普通会话"
								)
							: null
					])
				);
			}

			// 挪一条：按编号指定，没列出来的也能操作；列表里给的是最近 200 条。
			const sceneRowStyle = { ...S.row, flexBasis: "100%" };
			const moveRow = react.createElement("div", { key: "scene-move", style: sceneRowStyle }, [
				react.createElement("span", { key: "label", style: S.label }, "挪一条记忆"),
				react.createElement("input", {
					key: "id",
					style: S.input,
					value: sceneDraft.id,
					placeholder: "编号，例如 M-042",
					onChange: (event) =>
						setSceneDraft({ ...sceneDraft, id: plain(event && typeof event.target === "object" ? event.target.value : "") })
				}),
				react.createElement(
					"select",
					{
						key: "target",
						style: S.input,
						value: sceneDraft.target,
						onChange: (event) =>
							setSceneDraft({ ...sceneDraft, target: plain(event && typeof event.target === "object" ? event.target.value : "") })
					},
					[react.createElement("option", { key: "", value: "" }, "挪到…")].concat(
						poolChoices.map((choice) =>
							react.createElement("option", { key: choice.value, value: choice.value }, choice.label)
						)
					)
				),
				react.createElement("button", {
					key: "go",
					type: "button",
					style: S.button,
					disabled: busy || sceneDraft.id.trim() === "" || sceneDraft.target === "",
					onClick: () =>
						runSceneAction(
							{ action: "move", id: sceneDraft.id.trim(), scene: sceneDraft.target },
							"挪好了"
						)
				}, "挪过去")
			]);

			// 把目录并到某个项目：改的是映射，下一次召回立刻按新归属走。
			const projectChoices = (Array.isArray(sceneView && sceneView.projects) ? sceneView.projects : []).map((project) => ({
				value: plain(project.id),
				label: plain(project.name) || plain(project.id)
			}));
			const mergeRow = react.createElement("div", { key: "scene-merge", style: sceneRowStyle }, [
				react.createElement("span", { key: "label", style: S.label }, "把目录并进项目"),
				react.createElement("input", {
					key: "dir",
					style: S.input,
					value: sceneDraft.dir,
					placeholder: currentDir === "" ? "目录路径" : currentDir,
					onChange: (event) =>
						setSceneDraft({ ...sceneDraft, dir: plain(event && typeof event.target === "object" ? event.target.value : "") })
				}),
				react.createElement(
					"select",
					{
						key: "target",
						style: S.input,
						value: sceneDraft.project || "",
						onChange: (event) =>
							setSceneDraft({ ...sceneDraft, project: plain(event && typeof event.target === "object" ? event.target.value : "") })
					},
					[react.createElement("option", { key: "", value: "" }, "并进…")].concat(
						projectChoices.map((choice) =>
							react.createElement("option", { key: choice.value, value: choice.value }, choice.label)
						)
					)
				),
				react.createElement("button", {
					key: "go",
					type: "button",
					style: S.button,
					disabled: busy || (sceneDraft.dir.trim() === "" && currentDir === "") || (sceneDraft.project || "") === "",
					onClick: () =>
						runSceneAction(
							{
								action: "merge",
								dir: sceneDraft.dir.trim() === "" ? currentDir : sceneDraft.dir.trim(),
								scene: sceneDraft.project || ""
							},
							"并进去了"
						)
				}, "合并")
			]);
			if (projectChoices.length > 0) sceneNodes.push(mergeRow);
			if (poolChoices.length > 0) sceneNodes.push(moveRow);

			// 「通用层满了」的那些请求：不自己丢，等人决定。
			for (let i = 0; i < sceneRequests.length; i += 1) {
				const request = sceneRequests[i];
				sceneNodes.push(
					react.createElement("div", { key: "request-" + String(i), style: S.row }, [
						react.createElement("span", { key: "label", style: S.label }, plain(request.sceneLabel)),
						react.createElement("span", { key: "value", style: S.value }, plain(request.text)),
						react.createElement("span", { key: "hint", style: S.hint }, "满了，等你决定"),
						react.createElement("button", {
							key: "yes",
							type: "button",
							style: S.button,
							disabled: busy,
							onClick: () =>
								runSceneAction({ action: "decide", scene: plain(request.scene), text: plain(request.text), accept: true }, "放进去了")
						}, "放进这一层"),
						react.createElement("button", {
							key: "no",
							type: "button",
							style: S.button,
							disabled: busy,
							onClick: () =>
								runSceneAction({ action: "decide", scene: plain(request.scene), text: plain(request.text), accept: false }, "算了")
						}, "算了")
					])
				);
			}

			// 每条记忆为什么在这一层：最近 200 条，带编号、层、理由。
			for (let i = 0; i < sceneEntries.length; i += 1) {
				const entry = sceneEntries[i];
				sceneNodes.push(
					react.createElement("div", { key: "entry-" + String(i), style: S.row }, [
						react.createElement("span", { key: "label", style: S.label }, plain(entry.id) || "无编号"),
						react.createElement("span", { key: "value", style: S.value }, plain(entry.text)),
						react.createElement("span", { key: "hint", style: S.hint }, plain(entry.sceneLabel) + " · " + plain(entry.why))
					])
				);
			}
			if (sceneEntries.length > 0 && sceneTotal > sceneEntries.length) {
				sceneNodes.push(
					emptyLine(
						"scene-more",
						"这里列了最近 " + String(sceneEntries.length) + " 条，还有 " + String(sceneTotal - sceneEntries.length) + " 条没列出来；按编号仍然能挪"
					)
				);
			}
			if (sceneNote !== "") sceneNodes.push(emptyLine("scene-note", sceneNote));


			// 动作的结果贴在视口底部。这一页很长，提示若摆在顶部，人在下面点完按钮
			// 根本看不到（2026-11-11 用户反馈「点了写入没有提示」）。写入中先说一声。
			const toastText = busy ? "写入中…" : notice.text;
			const toastNode =
				toastText === ""
					? null
					: react.createElement(
							"p",
							{
								key: "toast",
								role: "status",
								"aria-live": "polite",
								style: notice.kind === "error" ? S.toastError : S.toast
							},
							toastText
					  );

			/** 一格：草稿优先，没改过就显示盘上现在的值。多行的用文本域。 */
			const identityRow = (entry, index) => {
				const key = plain(entry.key);
				const label = textOf(entry.label);
				const hint = plain(entry.hint);
				if (entry.writable === false) {
					return rowElement("identity-" + String(index), label, textOf(entry.value), hint);
				}
				const current = plain(entry.value);
				const typed = Object.prototype.hasOwnProperty.call(cardDraft, key) ? cardDraft[key] : current;
				const multiline = entry.multiline === true;
				const control = multiline
					? react.createElement("textarea", {
							key: "input",
							style: S.blockTextarea,
							rows: 3,
							value: typed,
							placeholder: EMPTY,
							disabled: busy,
							onChange: (event) => setCardField(key, event.target.value)
					  })
					: react.createElement("input", {
							key: "input",
							type: "text",
							style: S.input,
							value: typed,
							placeholder: EMPTY,
							disabled: busy,
							onChange: (event) => setCardField(key, event.target.value)
					  });
				const children = [
					react.createElement("span", { key: "label", style: S.label }, label),
					control,
					react.createElement(
						"button",
						{
							key: "apply",
							type: "button",
							style: S.button,
							// 只在「和盘上不一样」时可点：清空也是一次改动，空对空才没得写。
							disabled: busy || typed === current,
							onClick: () => writeIdentity(key, typed)
						},
						textOf(entry.action)
					)
				];
				if (hint.length > 0) {
					children.push(react.createElement("span", { key: "hint", style: S.hint }, hint));
				}
				return react.createElement("div", { key: "identity-" + String(index), style: S.row }, children);
			};
			const nameRows = identityRows.map(identityRow);

			// 库路径只能「选」，不给输入框：手打路径是这套东西里最容易出错的一步
			// （盘符、斜杠、看不见的空格），而目录选择器就在宿主里，没必要让人拼字符串。
			const vaultPathRow = react.createElement("div", { key: "vaultPath", style: S.row }, [
				react.createElement("span", { key: "label", style: S.label }, "库路径"),
				react.createElement("span", { key: "value", style: S.value }, draft.vaultPath === "" ? "" : draft.vaultPath),
				react.createElement(
					"button",
					{
						key: "pick",
						type: "button",
						style: S.button,
						disabled: busy || pickerAvailable === false,
						onClick: () => pick("vaultPath")
					},
					"选目录"
				)
			]);

			// 工作区总路径：派活时按项目名在这儿建目录。跟笔记库一样只给「选」不给打，
			// 理由相同——手拼路径是这套东西里最容易错的一步。
			const workRootRow = react.createElement("div", { key: "workRoot", style: S.row }, [
				react.createElement("span", { key: "label", style: S.label }, "工作区总路径"),
				react.createElement("span", { key: "value", style: S.value }, draft.workRoot === "" ? "" : draft.workRoot),
				react.createElement(
					"button",
					{
						key: "pick",
						type: "button",
						style: S.button,
						disabled: busy || pickerAvailable === false,
						onClick: () => pick("workRoot")
					},
					"选目录"
				)
			]);

			// 换库时那条路：默认把旧库的两块目录复制过来，取消勾选就只改指向。
			// 先复制再校验、最后才落地，所以旧库永远是完整的。
			const vaultMoveRow = react.createElement("div", { key: "vaultMove", style: S.row }, [
				react.createElement("span", { key: "label", style: S.label }, "换库时"),
				react.createElement("label", { key: "toggle", style: S.value }, [
					react.createElement("input", {
						key: "check",
						type: "checkbox",
						checked: moveOnSwitch,
						disabled: busy,
						onChange: (event) => setMoveOnSwitch(event.target.checked)
					}),
					" 把台账和上下文搬过去"
				]),
				react.createElement("span", { key: "hint", style: S.hint }, "只复制，旧库不动")
			]);

			// 人格总开关：关掉之后只留记忆与上下文压缩，人格 / 模式 / 进度三段不再进提示词。
			// 不删任何数据——卡片、记忆、档案都还在盘上，随时能再打开。
			const personaRow = react.createElement("div", { key: "personaSwitch", style: S.row }, [
				react.createElement("span", { key: "label", style: S.label }, "人格功能"),
				react.createElement("span", { key: "value", style: S.value }, personaOn ? "开着" : "关着"),
				react.createElement(
					"button",
					{
						key: "toggle",
						type: "button",
						style: S.button,
						disabled: busy,
						onClick: () => save({ personaEnabled: personaOn === false }, personaOn ? "关掉了" : "打开了")
					},
					personaOn ? "关掉人格" : "打开人格"
				),
				react.createElement(
					"span",
					{ key: "hint", style: S.hint },
					personaOn
						? "现在开着：人格卡、模式、进度会写进系统提示。关掉后这几段不再出现，记忆和上下文压缩照常跑"
						: "现在关着：插件只做记忆和上下文压缩，人格交给别的插件。一条数据都没删，随时能再打开"
				)
			]);

			const obsidianRow = react.createElement("div", { key: "obsidian", style: S.row }, [
				react.createElement("span", { key: "label", style: S.label }, "Obsidian 联动"),
				react.createElement("span", { key: "value", style: S.value }, obsidianOn ? "开着" : "关着"),
				react.createElement(
					"button",
					{
						key: "toggle",
						type: "button",
						style: S.button,
						disabled: busy,
						onClick: () => save({ obsidianEnabled: obsidianOn === false }, obsidianOn ? "关掉了" : "打开了")
					},
					obsidianOn ? "关掉这个开关" : "打开这个开关"
				)
			]);

			// 称呼边界：默认关着。关着时内核一个字都不提这件事，称呼怎么处理全看卡。
			// 文案只说会发生什么，不写「硬边界」「顺从角色」这类行话——人一眼要能看懂。
			const addressGuardRow = react.createElement("div", { key: "servile", style: S.row }, [
				react.createElement("span", { key: "label", style: S.label }, "主人、老板这类叫法"),
				react.createElement("span", { key: "value", style: S.value }, servileOn ? "会拒绝" : "不拦"),
				react.createElement(
					"button",
					{
						key: "toggle",
						type: "button",
						style: S.button,
						disabled: busy,
						onClick: () => save({ rejectServileAddress: servileOn === false }, servileOn ? "关掉了" : "打开了")
					},
					servileOn ? "关掉这条规矩" : "打开这条规矩"
				),
				react.createElement(
					"span",
					{ key: "hint", style: S.hint },
					servileOn
						? "现在开着：有人要它叫主人、老板、神明，它可以拒绝，并说清自己要的是平等对话"
						: "关着：怎么叫全听人格卡。打开后，遇到这类叫法它可以拒绝"
				)
			]);

			// 装没装、库在哪：只照宿主说的写，拿不到就整行不出现。
			const obsidianStateRow =
				obsidianLabel === ""
					? null
					: react.createElement("div", { key: "obsidian-state", style: S.row }, [
							react.createElement("span", { key: "label", style: S.label }, "联动状态"),
							react.createElement("span", { key: "value", style: S.value }, obsidianLabel)
						]);

			const obsidianNoVaultHint =
				obsidianInfo === null || obsidianHasVault
					? null
					: react.createElement(
							"div",
							{ key: "obsidian-hint", style: S.hint },
							"还没选笔记库，选好之后才能联动"
						);

			/** 每个小块各占一行：嵌套的 flex 行不给基宽，里面的下拉会被压成一条缝。 */
			const subRowStyle = { ...S.row, flexBasis: "100%" };

			// 已选的那些：路径摆在明面上，一点就移出。
			const whaleListRows =
				whalePaths.length === 0
					? [react.createElement("p", { key: "ws-empty", style: S.hint }, WORKSPACE_COPY.empty)]
					: whalePaths.map((path) =>
							react.createElement("div", { key: "wp-" + path, style: subRowStyle }, [
								react.createElement("span", { key: "path", style: S.value }, path),
								react.createElement("button", {
									key: "remove",
									type: "button",
									style: S.button,
									disabled: busy,
									onClick: () => saveWhaleWorkspaces(whalePaths.filter((item) => item !== path), "移出")
								}, WORKSPACE_COPY.remove)
							])
					  );

			// 宿主认识的、还没加进来的工作区，全收进一个下拉：再多也只占一行。
			const pendingWorkspaces = [];
			const seenKeys = new Set();
			for (const workspace of workspaces) {
				const path = plain(workspace.path);
				const key = normPath(path);
				if (key === "" || seenKeys.has(key) || whaleKeySet.has(key)) continue;
				seenKeys.add(key);
				pendingWorkspaces.push({ path: path, title: plain(workspace.title) });
			}

			// 挑工作区那一行：能挑就摆下拉，挑不了（读不到 / 全加过）就在原位说一句。
			// 标签一直挂着，块再空也知道这一行是什么。
			const pickerNote =
				workspaces.length === 0
					? WORKSPACE_COPY.unreadable
					: pendingWorkspaces.length === 0
					? WORKSPACE_COPY.allAdded
					: "";
			const pickerChildren = [react.createElement("span", { key: "label", style: S.label }, WORKSPACE_COPY.label)];
			if (pickerNote !== "") {
				pickerChildren.push(react.createElement("span", { key: "note", style: S.note }, pickerNote));
			} else {
				pickerChildren.push(
					react.createElement(
						"select",
						{
							key: "select",
							style: S.select,
							value: workspaceChoice,
							disabled: busy,
							onChange: (event) =>
								setWorkspaceChoice(event && typeof event.target === "object" ? plain(event.target.value) : "")
						},
						[react.createElement("option", { key: "none", value: "" }, WORKSPACE_COPY.pick)].concat(
							pendingWorkspaces.map((item) =>
								react.createElement(
									"option",
									{ key: item.path, value: item.path },
									item.title === "" ? item.path : item.title + "（" + item.path + "）"
								)
							)
						)
					),
					react.createElement("button", {
						key: "add-picked",
						type: "button",
						style: S.button,
						disabled: busy || workspaceChoice === "",
						onClick: () => {
							if (workspaceChoice === "") return;
							const chosen = workspaceChoice;
							setWorkspaceChoice("");
							saveWhaleWorkspaces(whalePaths.concat([chosen]), "加入");
						}
					}, WORKSPACE_COPY.add)
				);
			}
			const workspacePicker = react.createElement("div", { key: "ws-pick", style: subRowStyle }, pickerChildren);

			const workspaceManualRow = react.createElement("div", { key: "ws-manual", style: subRowStyle }, [
				react.createElement("span", { key: "label", style: S.label }, WORKSPACE_COPY.manualLabel),
				react.createElement("input", {
					key: "input",
					style: S.input,
					value: workspaceInput,
					placeholder: WORKSPACE_COPY.placeholder,
					onChange: (event) =>
						setWorkspaceInput(event && typeof event.target === "object" ? plain(event.target.value) : "")
				}),
				react.createElement("button", {
					key: "add",
					type: "button",
					style: S.button,
					disabled: busy || workspaceInput.trim() === "",
					onClick: () => {
						const path = workspaceInput.trim();
						if (path === "") return;
						setWorkspaceInput("");
						saveWhaleWorkspaces(whalePaths.concat([path]), "加入");
					}
				}, WORKSPACE_COPY.add)
			]);

			const workspaceRow = react.createElement("div", { key: "workspaces", style: S.row }, [
				workspacePicker,
				...whaleListRows,
				workspaceManualRow
			]);

			const accountingRows = [
				["shortFacts", "短事实"],
				["shortPreferences", "短偏好"],
				["longMemory", "长期记忆"],
				["commitments", "承诺"],
				["revision", "修订号"]
			].map((pair) =>
				react.createElement("div", { key: "acc-" + pair[0], style: S.row }, [
					react.createElement("span", { key: "label", style: S.label }, pair[1]),
					react.createElement("span", { key: "value", style: S.value }, textOf(accounting[pair[0]]))
				])
			);

			const health = isObject(data) && isObject(data.health) ? data.health : null;
			const healthState = health && typeof health.state === "string" ? health.state : "";
			const healthWords = { normal: "正常", readonly: "只读", disabled: "停用" };
			const healthNotes = health && Array.isArray(health.notes) ? health.notes.filter((item) => typeof item === "string" && item !== "") : [];
			const grace = health && isObject(health.grace) ? health.grace : null;
			const graceHint =
				grace && grace.active === true && typeof grace.readOnlyUntil === "string"
					? "新装只读复核到 " + grace.readOnlyUntil
					: "";
			const healthHint = graceHint !== "" ? graceHint : healthNotes.length > 0 ? healthNotes[0] : "";

			// 升级只显示一行：最近一次完成标记的版本与结果。没有标记就不占位。
			const upgrade = isObject(data) && isObject(data.upgrade) ? data.upgrade : null;
			const upgradeNever = upgrade !== null && upgrade.never === true;
			const upgradeVersion = upgrade !== null && typeof upgrade.vaultVersion === "string" ? upgrade.vaultVersion : "";
			const upgradeText = upgradeNever === true ? "还没升过版" : upgradeVersion === "" ? "有一份记录" : upgradeVersion;
			const upgradeHint =
				upgrade !== null && typeof upgrade.file === "string" && upgrade.file !== ""
					? upgrade.done === true
						? "跑完了：" + upgrade.file
						: "没跑完：" + upgrade.file
					: "";

			// 上下文档案也只显示一行：多少份、最近哪一份；没选库就照实说。
			const ctxState = isObject(data) && isObject(data.ctx) ? data.ctx : null;
			const ctxReady = ctxState !== null && ctxState.ready === true;
			const ctxCount = ctxState !== null && typeof ctxState.cards === "number" ? ctxState.cards : 0;
			const ctxText = ctxReady !== true ? "还没选库" : ctxCount === 0 ? "还没有档案" : ctxCount + " 份";
			const ctxHint =
				ctxReady === true && typeof ctxState.lastId === "string" && ctxState.lastId !== ""
					? "最近：" + ctxState.lastId + " · " + (typeof ctxState.lastTopic === "string" ? ctxState.lastTopic : "")
					: "";
			// 命令名和参数没人记得住，所以这一格自己把「怎么看全部」和「更省事的办法」写出来。
			const ctxUsage = "用法：敲 /whale ctx 看全部；嫌麻烦就直接跟我说「落盘」「还剩多少」。";

			// ---- 人格卡：整段粘进来拆开，或者逐项改
			// 字数直接从内核账里取：界面上的数字和真正注入的字数必须同源，
			// 各算一份迟早会对不上。
			const kernel = isObject(data) && isObject(data.view) && isObject(data.view.kernel) ? data.view.kernel : null;
			const humanChars = kernel !== null && typeof kernel.human === "number" ? kernel.human : null;
			const humanLimit =
				kernel !== null && isObject(kernel.limits) && typeof kernel.limits.human === "number"
					? kernel.limits.human
					: 1000;
			const kernelOver = humanChars !== null && humanChars > humanLimit;
			const kernelText =
				humanChars === null
					? ""
					: kernelOver
						? "十一项里有 " + String(humanChars) + " 字进内核，超过软上限 " + String(humanLimit) + " 字：每轮对话都要带这么多"
						: "十一项里有 " + String(humanChars) + " 字进内核（软上限 " + String(humanLimit) + " 字）";
			const kernelNode =
				kernelText === "" ? null : react.createElement("span", { key: "kernel", style: S.hint }, kernelText);

			const archived = isObject(data) && isObject(data.card) ? data.card : null;
			const archiveChars = archived !== null && typeof archived.chars === "number" ? archived.chars : 0;
			const archiveNode =
				archiveChars === 0
					? emptyLine("archive-empty", "还没存过原文")
					: react.createElement(
							"span",
							{ key: "archive", style: S.hint },
							"原文已存 " + String(archiveChars) + " 字"
					  );

			const pasteNode = react.createElement("textarea", {
				key: "card-raw",
				style: S.textarea,
				rows: 7,
				value: cardRaw,
				placeholder:
					"把整段人格设定粘进来，比如：\n名称：鲸鲸\n\n## 价值观\n自由、公平\n\n## 边界\n- 不主动骂人\n- 不接受被骂",
				disabled: busy,
				onChange: (event) => setCardRaw(event.target.value)
			});

			const cardButtons = react.createElement("div", { key: "card-buttons", style: S.row }, [
				react.createElement(
					"button",
					{
						key: "split",
						type: "button",
						style: S.button,
						disabled: busy || cardRaw.trim() === "",
						onClick: () => splitCard(CARD_PARSE_ROUTE)
					},
					"拆一下"
				),
				react.createElement(
					"button",
					{
						key: "split-model",
						type: "button",
						style: S.button,
						disabled: busy || cardRaw.trim() === "",
						onClick: () => splitCard(CARD_SPLIT_ROUTE)
					},
					"让模型帮我拆"
				),
				react.createElement(
					"button",
					{ key: "apply-all", type: "button", style: S.button, disabled: busy, onClick: applyCardAll },
					"全部写进去"
				)
			]);

			const cardNoteNode =
				cardNote === "" ? null : react.createElement("p", { key: "card-note", style: S.lead }, cardNote);

			/** 十一项的中文名从宿主的行里取：界面上说的「说话」，要和存下去的那一格对得上。 */
			const fieldLabel = (key) => {
				for (const entry of identityRows) {
					if (plain(entry.key) === key) return textOf(entry.label) || key;
				}
				return key;
			};

			// 段落的账按实际去向算：被模型搬进十一项的那几段不再算「没进内核」。
			const leftSections = cardSections.filter((item) => typeof item.movedTo !== "string" || item.movedTo === "");
			const movedSections = cardSections.length - leftSections.length;
			const sectionChars = leftSections.reduce((sum, item) => sum + item.chars, 0);
			const sectionsHeadCopy =
				movedSections === 0
					? "另有 " + String(leftSections.length) + " 段（" + String(sectionChars) + " 字）没进内核，原样存着——它们不会出现在对话里"
					: "还有 " + String(leftSections.length) + " 段（" + String(sectionChars) + " 字）没进内核，原样存着；另外 " + String(movedSections) + " 段被模型搬进了十一项，下面标了去向";
			const sectionsNode =
				cardSections.length === 0
					? null
					: react.createElement("div", { key: "card-sections", style: S.cardBox }, [
							react.createElement("p", { key: "sections-title", style: S.lead }, sectionsHeadCopy),
							...cardSections.map((item, index) =>
								react.createElement("details", { key: "section-" + String(index) }, [
									react.createElement(
										"summary",
										{ key: "section-head", style: S.sectionHead },
										(item.title === "" ? "开头那段" : item.title) +
											" · " +
											String(item.chars) +
											" 字" +
											(typeof item.movedTo === "string" && item.movedTo !== ""
												? " → " + fieldLabel(item.movedTo)
												: "")
									),
									react.createElement("pre", { key: "section-body", style: S.pre }, item.text || item.heading)
								])
							)
					  ]);

			/**
			 * 模型没归进十一项的段：它自己说了为什么。这一段是账，不是建议——
			 * 人看到「这几段没进去」，才知道内核里到底缺了什么。
			 * 不写「没装下」：有些段是它判断不该进内核（记忆怎么写、平台通用条款），
			 * 不是塞不下。原因由它自己写，人照着判断要不要手填。
			 */
			const unusedNode =
				cardUnused.length === 0
					? null
					: react.createElement("div", { key: "card-unused", style: S.cardBox }, [
							react.createElement(
								"p",
								{ key: "unused-title", style: S.lead },
								"模型没归进十一项的 " + String(cardUnused.length) + " 段（原文还在，没删）"
							),
							...cardUnused.map((item, index) =>
								react.createElement(
									"p",
									{ key: "unused-" + String(index), style: S.hint },
									item.why === "" ? item.from : item.from + " —— " + item.why
								)
							)
					  ]);

			/**
			 * 模型的搬运清单：哪一段去了哪一项。
			 *
			 * 为什么要单独列：字段框里只有结果，人没法判断「这段是不是被它搬丢了」。
			 * 有了这张表，加上下面原样存着的段落，就是对得起来的账。
			 */
			const movesNode =
				cardMoves.length === 0
					? null
					: react.createElement("div", { key: "card-moves", style: S.cardBox }, [
							react.createElement(
								"p",
								{ key: "moves-title", style: S.lead },
								"模型说它这样搬的（" + String(cardMoves.length) + " 段）"
							),
							...cardMoves.map((item, index) =>
								react.createElement(
									"p",
									{ key: "move-" + String(index), style: S.hint },
									"「" + item.from + "」→ " + fieldLabel(item.to)
								)
							)
					  ]);

			const cardNodes = [
				react.createElement(
					"p",
					{ key: "card-lead", style: S.lead },
					"把整段人格设定粘进来点「拆一下」，我按名称、称呼、价值观、边界这些分好，你逐项改。规则拆不准时再点「让模型帮我拆」——那一条会花一次调用，它会把落空的段落压进十一项，并交代每段去了哪。"
				),
				pasteNode,
				cardButtons,
				cardNoteNode,
				movesNode,
				react.createElement("div", { key: "card-box", style: S.cardBox }, nameRows),
				sectionsNode,
				unusedNode,
				react.createElement("div", { key: "card-foot", style: S.row }, [archiveNode, kernelNode])
			];

			return react.createElement("div", { style: S.page }, [
				head[0],
				head[1],
				healthState === ""
					? null
					: react.createElement("div", { key: "health", style: S.row }, [
							react.createElement("span", { key: "label", style: S.label }, "装载状态"),
							react.createElement("span", { key: "value", style: S.value }, healthWords[healthState] || healthState),
							healthHint === "" ? null : react.createElement("span", { key: "hint", style: S.hint }, healthHint)
						]),
				upgrade === null
					? null
					: react.createElement("div", { key: "upgrade", style: S.row }, [
							react.createElement("span", { key: "label", style: S.label }, "上次升级"),
							react.createElement("span", { key: "value", style: S.value }, upgradeText),
							upgradeHint === "" ? null : react.createElement("span", { key: "hint", style: S.hint }, upgradeHint)
						]),
				ctxState === null
					? null
					: react.createElement("div", { key: "ctx", style: S.row }, [
						react.createElement("span", { key: "label", style: S.label }, "上下文档案"),
						react.createElement("span", { key: "value", style: S.value }, ctxText),
						ctxHint === "" ? null : react.createElement("span", { key: "hint", style: S.hint }, ctxHint),
						react.createElement("span", { key: "usage", style: S.hint }, ctxUsage),
					]),
				groupElement("persona-switch", "人格开关", "关掉后插件只做记忆和上下文压缩，不再往系统提示里写人格。", [personaRow]),
				groupElement("card", "人格卡", "", cardNodes),
				groupElement("guard", "额外一条称呼规矩", "插件自己加的，不在人格卡里；默认关着。", [addressGuardRow]),
				groupElement("vault", "笔记库", "", [
					vaultPathRow,
					vaultMoveRow,
					pickerAvailable === false
						? react.createElement(
								"span",
								{ key: "picker-hint", style: S.hint },
								"这台机器没给我选目录的窗口，路径可以直接粘进来"
							)
						: null,
					draft.vaultPath === "" ? emptyLine("vaultPath-empty", EMPTY) : null,
					obsidianRow,
					obsidianStateRow,
					obsidianNoVaultHint
				]),
				groupElement("workroot", "任务工作区", "派活时按项目名在这里建目录，一个项目一个子目录；空着就没法派。", [
					workRootRow,
					pickerAvailable === false
						? react.createElement(
								"span",
								{ key: "workroot-picker-hint", style: S.hint },
								"这台机器没给我选目录的窗口，路径可以直接粘进来"
							)
						: null,
					draft.workRoot === "" ? emptyLine("workRoot-empty", "还没设。派活前先选一个目录") : null
				]),
				groupElement(
					"workspaces",
					"工作区模式",
					"列在这儿的工作区走鲸鲸模式，其余一律助手模式；新会话起手选了「鲸鲸」预设的，不看目录也走鲸鲸。",
					[workspaceRow]
				),
				groupElement("accounting", "记了多少", "这些是现在的底数，改了也不会在这里显示新值。", accountingRows),
				groupElement(
					"scene",
					"记忆分层",
					"记忆按场景分开，各有各的名额；这儿看得见它归在哪一层、为什么。",
					sceneNodes
				),
				react.createElement("div", { key: "footer", style: S.row }, [
					react.createElement("button", { key: "reload", type: "button", style: S.button, disabled: busy, onClick: reload }, "再读一次")
				]),
				toastNode
			]);
		}

		//#endregion

		//#region 插件入口

		/** 只等 slots：设置页完全走 HTTP，不碰宿主服务。 */
		const inject = ["slots"];

		function apply(ctx) {
			if (ctx === undefined || ctx === null || ctx.slots === undefined || ctx.slots === null) return;
			const slots = ctx.slots;
			const registerable = typeof slots.register === "function";
			if (registerable === false) return;

			const register = () =>
				slots.register(
					{
						name: SECTION_SLOT,
						id: SECTION_ID,
						order: SECTION_ORDER,
						label: () => SECTION_LABEL
					},
					WhalePalSection
				);

			/*
			 * settings.section 是别人声明的槽。声明还没落地时直接 register 会抛
			 * 「slot settings.section is not declared」，那一轮注册就丢了。
			 * 所以先走 slots.inject 等声明（已经在就直接跑），拿到声明再 register。
			 */
			const waitThenRegister = () => {
				if (typeof slots.inject === "function") return slots.inject(SECTION_SLOT, register);
				return register();
			};

			try {
				if (typeof ctx.effect === "function") ctx.effect(() => waitThenRegister(), "whale-pal: settings section");
				else waitThenRegister();
			} catch (error) {
				try {
					console.warn("[dsh-whale-pal] settings section registration failed", error);
				} catch (ignored) {}
			}
		}

		//#endregion

		exports.name = "dsh-whale-pal";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
