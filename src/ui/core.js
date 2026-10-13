// Steam 家庭库透视 —— 与宿主无关的界面核心。
//
// `createFamilyLensUi(host)` 只通过 host 访问外界，因此同一份代码可以用在两种宿主上：
//   · 免安装原型：host.doc = Steam 主窗口的 document（经 CDP 注入到那个上下文）
//   · Millennium 插件：host.doc = g_PopupManager 拿到的主窗口 document（跑在 SharedJSContext）
// 所有类名以 fl- 开头，不改动 Steam 自身样式（仅按需补 position:relative）。

// 纯逻辑单独保留，便于脱离 Steam 界面做回归测试。
function familyLensAllowedIds(appIndex, selectedMembers, mode, ownedByIds) {
  const ids = new Set();
  for (const appid of appIndex.keys()) {
    if (!selectedMembers.length) {
      ids.add(appid);
      continue;
    }
    const owners = ownedByIds(appid);
    if (mode === 'intersection'
      ? selectedMembers.every((id) => owners.includes(id))
      : selectedMembers.some((id) => owners.includes(id))) ids.add(appid);
  }
  return ids;
}

function familyLensMergeHomeIds(original, current, validIds) {
  const merged = original.filter((id) => validIds.has(id));
  const seen = new Set(merged);
  for (const id of current) {
    if (validIds.has(id) && !seen.has(id)) {
      merged.push(id);
      seen.add(id);
    }
  }
  return merged;
}

function familyLensKeepCards(raw, knownCardKeys, libraryRightEdge, detailAppId) {
  const counts = new Map();
  for (const card of raw) counts.set(card.key, (counts.get(card.key) || 0) + 1);
  return raw.filter((card) => {
    if (counts.get(card.key) >= 3) {
      knownCardKeys.add(card.key);
      return true;
    }
    if (knownCardKeys.has(card.key)) return true;
    const src = card.img.currentSrc || card.img.src || '';
    const r = card.rect;
    // 收藏夹里只有一两款游戏时也要识别；排除详情页配图和左侧小图标。
    return detailAppId === null && libraryRightEdge > 0 && r.left >= libraryRightEdge &&
      r.width >= 80 && r.width <= 320 && r.height >= 120 &&
      r.height >= r.width * 1.2 && /library_600x900|library_capsule/.test(src);
  });
}

function familyLensNormalizePreferences(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const placement = raw.placement === 'fixed' ? 'sticky'
    : ['follow', 'sticky', 'hidden'].includes(raw.placement) ? raw.placement : 'follow';
  const density = ['standard', 'compact'].includes(raw.density) ? raw.density : 'standard';
  const number = (input, fallback, min, max) => Number.isFinite(Number(input))
    ? Math.min(max, Math.max(min, Math.round(Number(input)))) : fallback;
  // 新键只表达从右上角向左/下的距离；旧版有正负偏移，按当前模式迁移并钳到可表示范围。
  const oldVertical = Number(raw.verticalOffset);
  const legacyVertical = Number.isFinite(oldVertical) && raw.verticalOffset != null
    ? oldVertical + (placement === 'follow' ? 56 : 8)
    : raw.placement === 'fixed' ? Number(raw.fixedTopOffset)
      : placement === 'follow' ? Number(raw.topOffset) : 0;
  const oldHorizontal = Number(raw.horizontalOffset);
  const legacyHorizontal = Number.isFinite(oldHorizontal) && raw.horizontalOffset != null
    ? 18 - oldHorizontal : Number(raw.rightInset);
  return {
    placement,
    density,
    opacity: number(raw.opacity, 95, 65, 100),
    verticalInset: number(raw.verticalInset, Number.isFinite(legacyVertical) ? legacyVertical : 0, 0, 240),
    horizontalInset: number(raw.horizontalInset, Number.isFinite(legacyHorizontal) ? legacyHorizontal : 0, 0, 200),
    showAvatars: raw.showAvatars !== false,
  };
}

function familyLensPanelGeometry(heroRect, viewport, panelHeight, preferences) {
  const p = familyLensNormalizePreferences(preferences);
  const headerBottom = Math.max(0, viewport.headerBottom ?? viewport.occlusionBottom ?? 0);
  const occlusionBottom = Math.max(headerBottom, viewport.occlusionBottom ?? headerBottom);
  const followBase = heroRect.top;
  const safeTop = occlusionBottom;
  const baseTop = p.placement === 'sticky' ? Math.max(followBase, safeTop) : followBase;
  const top = Math.round(baseTop + p.verticalInset);
  const right = Math.max(0, Math.round(viewport.width - heroRect.right + p.horizontalInset));
  // 仅随封面真正滚入主顶栏时才裁切；调整非负偏移不会凭空切掉面板顶部。
  const clipTop = p.placement === 'follow' && heroRect.top < headerBottom
    ? Math.max(0, Math.ceil(headerBottom - top)) : 0;
  const hidden = p.placement === 'hidden' ||
    (p.placement === 'follow' &&
      (heroRect.bottom <= headerBottom || heroRect.top >= viewport.height || top + panelHeight <= headerBottom)) ||
    (p.placement === 'sticky' && heroRect.top >= viewport.height);
  return { top, right, clipTop, hidden };
}

function familyLensTooltipGeometry(anchor, size, viewport) {
  const margin = 8;
  const left = Math.max(margin, Math.min(
    Math.round(anchor.left + anchor.width / 2 - size.width / 2),
    viewport.width - size.width - margin,
  ));
  const below = Math.round(anchor.bottom + margin);
  const top = below + size.height <= viewport.height - margin
    ? below : Math.max(margin, Math.round(anchor.top - size.height - margin));
  return { left, top };
}

function createFamilyLensUi(host) {
  const doc = host.doc;
  const win = host.win;
  const NS = (host.meta && host.meta.namespace) || '__FAMILY_LENS__';
  const VERSION = 62;
  const ACCOUNT_BASE = 76561197960265728n;

  const AVATAR_URL = (hash) => (hash ? `https://avatars.steamstatic.com/${hash}_medium.jpg` : '');

  const state = {
    version: VERSION,
    data: null, // 来自 SharedJSContext 的快照
    lenders: {}, // appid -> [{ accountId, preferred }]
    selectedMembers: [], // 多选成员；空数组=全部
    filterMode: 'union', // union=总共持有，intersection=共同持有
    appIndex: new Map(), // appid -> { owner, copies, canonicalType, isFree, excludedFromSharing }
    freeStatuses: new Map(), // 已向 Steam 详情接口确认的免费标记，跨快照保留
    sharingStatuses: new Map(), // Steam 明确标记「不可家庭共享」的状态
    memberIndex: new Map(), // accountId -> member
    preferences: familyLensNormalizePreferences(null),
    preferencesAccountId: null,
    lastDataAt: 0,
    dataVersion: 0,
    dataFingerprint: '',
    lendersVersion: 0,
    stats: { badges: 0, cards: 0, filterHits: 0 },
  };

  // ---------------------------------------------------------------- 样式
  const STYLE_ID = 'fl-style';
  const CSS = `
    .fl-badge{position:absolute;top:3px;right:5px;z-index:40;display:flex;align-items:center;gap:5px;
      padding:1px 6px 1px 4px;border-radius:11px;background:rgba(11,14,20,.82);
      box-shadow:0 1px 4px rgba(0,0,0,.5);pointer-events:none;font-size:10px;line-height:16px;
      color:#c7d5e0;white-space:nowrap;backdrop-filter:blur(2px);}
    .fl-badge.is-multi{background:linear-gradient(90deg,rgba(38,86,140,.92),rgba(11,14,20,.86));}
    .fl-badge.fl-badge-row{top:50%;transform:translateY(-50%);right:8px;}
    .fl-avatars{display:flex;align-items:center;}
    .fl-avatars img{width:16px;height:16px;border-radius:50%;border:1px solid rgba(0,0,0,.6);
      object-fit:cover;display:block;background:#2a3f5a;}
    .fl-avatars img+img{margin-left:-6px;}
    .fl-avatars .fl-more{width:16px;height:16px;margin-left:-6px;border-radius:50%;
      border:1px solid rgba(0,0,0,.6);background:#3d5a80;color:#fff;font-size:9px;
      display:flex;align-items:center;justify-content:center;}
    .fl-count{font-weight:600;letter-spacing:.2px;}
    /* 仅在顶栏 DOM 不可用时回退到库内容区。 */
    .fl-bar{position:fixed;top:82px;right:18px;z-index:100000;display:flex;align-items:center;gap:6px;
      padding:6px 9px;border-radius:9px;background:rgba(18,22,30,.94);
      box-shadow:0 4px 16px rgba(0,0,0,.55);border:1px solid rgba(102,192,244,.18);
      font-family:inherit;font-size:12px;color:#c7d5e0;pointer-events:none;-webkit-app-region:no-drag;}
    .TopBar .SuperNavBar .SuperNav:has(> .fl-header){position:relative;}
    .fl-bar.fl-header{position:absolute;top:0;right:0;height:42px;box-sizing:border-box;
      padding:2px 6px;gap:4px;border-radius:4px;background:rgba(18,22,30,.88);
      box-shadow:none;pointer-events:auto;max-width:calc(100% - 510px);overflow-x:auto;scrollbar-width:none;}
    .fl-bar.fl-header::-webkit-scrollbar{display:none;}
    .fl-bar.fl-header .fl-title{white-space:nowrap;font-size:12px;}
    .fl-bar.fl-header .fl-chip{width:36px;height:38px;flex:none;}
    .fl-bar.fl-header .fl-chip img{width:32px;height:32px;}
    .fl-bar.fl-header .fl-chip .fl-n{font-size:10px;line-height:12px;}
    .fl-bar.fl-header .fl-chip.fl-all{height:34px;font-size:12px;}
    .fl-bar.fl-header .fl-mode{height:34px;flex:none;font-size:11px;padding:0 7px;}
    .fl-bar button{position:relative;box-sizing:border-box;pointer-events:auto;isolation:isolate;-webkit-app-region:no-drag;}
    /* 用真实节点覆盖按钮表面；伪元素在 Steam 顶栏的头像区未可靠接收点击。 */
    .fl-bar button .fl-hit{position:absolute;inset:0;z-index:2;cursor:pointer;pointer-events:auto;
      -webkit-app-region:no-drag;}
    .fl-bar .fl-title{font-size:11px;opacity:.7;margin-right:2px;user-select:none;}
    .fl-chip{position:relative;width:32px;height:39px;border-radius:4px;cursor:pointer;
      border:2px solid transparent;padding:0;background:transparent;overflow:hidden;transition:border-color .12s;}
    .fl-chip img{width:28px;height:28px;border-radius:2px;object-fit:cover;display:block;background:#2a3f5a;
      pointer-events:none;-webkit-user-drag:none;user-select:none;-webkit-app-region:no-drag;}
    .fl-chip:hover{border-color:rgba(102,192,244,.55);}
    .fl-chip.fl-on{border-color:#66c0f4;box-shadow:0 0 8px rgba(102,192,244,.65);}
    .fl-chip .fl-n{position:absolute;left:0;right:0;bottom:0;box-sizing:border-box;text-align:center;background:rgba(11,14,20,.92);
      border-radius:3px;padding:0 2px;font-size:9px;line-height:12px;color:#c7d5e0;pointer-events:none;}
    .fl-chip.fl-all{height:28px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#c7d5e0;background:#2a3f5a;}
    .fl-mode{height:27px;padding:0 6px;border:1px solid #3d5368;border-radius:4px;background:#202d3b;
      color:#a9bac9;font:inherit;font-size:10px;white-space:nowrap;cursor:pointer;}
    .fl-mode.fl-on{border-color:#66c0f4;background:#254665;color:#fff;}
    .fl-settings-button{width:34px;height:34px;flex:none;border:1px solid #3d5368;border-radius:4px;
      background:#202d3b;color:#c7d5e0;font-size:18px;line-height:1;cursor:pointer;}
    .fl-settings-button:hover{border-color:#66c0f4;color:#fff;}
    .fl-bar.fl-header .fl-settings-button{height:34px;}
    .fl-member-tooltip{position:fixed;z-index:100001;box-sizing:border-box;max-width:min(300px,calc(100vw - 16px));
      padding:7px 10px;border:1px solid #4c708a;border-radius:5px;background:#17212d;
      box-shadow:0 5px 16px rgba(0,0,0,.65);color:#c7d5e0;font:12px/1.45 Arial,sans-serif;
      overflow-wrap:anywhere;white-space:normal;pointer-events:none;}
    /* 独立跟踪封面坐标；滚动时每帧同步，不依赖 Steam 的定位父节点。 */
    .fl-panel{position:fixed;z-index:1;box-sizing:border-box;width:276px;padding:10px 12px;
      border-radius:10px;background:rgba(18,22,30,var(--fl-panel-opacity,.95));border:1px solid rgba(102,192,244,.22);
      box-shadow:0 6px 22px rgba(0,0,0,.6);font-size:12px;color:#c7d5e0;}
    .fl-panel.fl-compact{width:242px;padding:7px 9px;font-size:11px;}
    .fl-panel.fl-compact .fl-holder{padding:1px 0;gap:6px;}
    .fl-panel.fl-compact .fl-holder img{width:18px;height:18px;}
    .fl-panel.fl-no-avatars .fl-holder > :first-child:not(:last-child){display:none;}
    .fl-panel h4{margin:0 0 8px;font-size:12px;font-weight:600;color:#fff;letter-spacing:.3px;}
    .fl-panel .fl-sub{opacity:.65;font-size:11px;margin-bottom:8px;}
    .fl-panel .fl-restrict{margin:0 0 8px;padding:6px 7px;border-left:2px solid #e2a03f;
      background:rgba(226,160,63,.1);color:#eac389;font-size:11px;line-height:1.4;}
    .fl-holder{display:flex;align-items:center;gap:8px;padding:3px 0;}
    .fl-holder img{width:22px;height:22px;border-radius:50%;background:#2a3f5a;}
    .fl-settings-overlay{position:fixed;inset:0;z-index:100002;display:flex;align-items:center;
      justify-content:center;background:rgba(0,0,0,.55);color:#c7d5e0;font:12px Arial,sans-serif;
      -webkit-app-region:no-drag;}
    .fl-settings-dialog{box-sizing:border-box;width:min(390px,92vw);padding:16px;border-radius:9px;
      border:1px solid #4c708a;background:#17212d;box-shadow:0 10px 35px #000;}
    .fl-settings-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
    .fl-settings-head h3{margin:0;color:#fff;font-size:16px;}
    .fl-settings-dialog button,.fl-settings-dialog select,.fl-settings-dialog input{font:inherit;}
    .fl-settings-dialog button{padding:5px 8px;border:1px solid #4c708a;border-radius:4px;
      background:#202d3b;color:#c7d5e0;cursor:pointer;}
    .fl-settings-dialog button:hover{border-color:#66c0f4;color:#fff;}
    .fl-settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:9px 0;}
    .fl-settings-row select{min-width:145px;padding:5px;background:#202d3b;color:#c7d5e0;border:1px solid #4c708a;}
    .fl-settings-row .fl-range-control{display:grid;grid-template-columns:145px 54px;align-items:center;
      gap:8px;flex:none;min-width:207px;}
    .fl-settings-row input[type=range]{box-sizing:border-box;width:145px;margin:0;-webkit-app-region:no-drag;}
    .fl-settings-row .fl-range-value{width:54px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
    .fl-settings-row label{display:flex;align-items:center;gap:6px;}
    .fl-settings-note{margin:12px 0;color:#8fa7b8;line-height:1.5;}
    /* 没有 Steam 原生筛选对象的免安装宿主仍可回退到可逆隐藏。 */
    [data-fl-hidden="1"]{visibility:hidden !important;pointer-events:none !important;}
    .fl-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:100001;
      padding:7px 14px;border-radius:16px;background:rgba(18,22,30,.95);color:#c7d5e0;font-size:12px;
      box-shadow:0 4px 16px rgba(0,0,0,.5);}
    /* 窗口窄的时候把筛选条整体收小，别把 Steam 自己的内容挡住 */
    @media (max-width: 1180px){
      .fl-bar{gap:3px;padding:5px 7px;}
      .fl-bar .fl-chip{width:26px;height:32px;border-width:1px;}
      .fl-bar .fl-chip img{width:24px;height:24px;}
      .fl-bar .fl-chip .fl-n{font-size:8px;line-height:10px;padding:0 2px;}
      .fl-bar .fl-chip.fl-all{height:24px;}
      .fl-bar.fl-header{padding:2px 5px;max-width:calc(100% - 515px);}
      .fl-bar.fl-header .fl-chip{width:34px;height:38px;}
      .fl-bar.fl-header .fl-chip img{width:30px;height:30px;}
      .fl-bar.fl-header .fl-chip.fl-all{height:34px;}
    }
    @media (max-width: 920px){
      .fl-bar{max-width:54vw;overflow-x:auto;scrollbar-width:none;}
      .fl-bar::-webkit-scrollbar{display:none;}
      .fl-bar.fl-header{max-width:calc(100% - 300px);}
    }
  `;

  /**
   * 注入样式。注意不能只在"元素不存在"时创建：注入器热重载新版本时，
   * 如果旧样式表还在，新的 CSS 就永远进不去（曾经因此让筛选样式完全失效）。
   * 这里用版本号做指纹，版本一变就重写内容。
   */
  function ensureStyle() {
    let style = doc.getElementById(STYLE_ID);
    if (!style) {
      style = doc.createElement('style');
      style.id = STYLE_ID;
      (doc.head || doc.documentElement).appendChild(style);
    }
    if (style.dataset.flCss !== String(VERSION)) {
      style.textContent = CSS;
      style.dataset.flCss = String(VERSION);
    }
  }

  // ---------------------------------------------------------------- 数据
  function preferencesKey(accountId) {
    return `familyLens.preferences.v1.${accountId}`;
  }

  function loadPreferences(accountId) {
    state.preferencesAccountId = accountId;
    try {
      state.preferences = familyLensNormalizePreferences(
        JSON.parse(win.localStorage.getItem(preferencesKey(accountId)) || 'null'),
      );
    } catch (e) {
      state.preferences = familyLensNormalizePreferences(null);
    }
  }

  function updatePreferences(patch) {
    state.preferences = familyLensNormalizePreferences({ ...state.preferences, ...patch });
    if (state.preferencesAccountId) {
      try {
        win.localStorage.setItem(preferencesKey(state.preferencesAccountId), JSON.stringify(state.preferences));
      } catch (e) { /* 存储不可用时本次会话仍生效 */ }
    }
    schedulePanelPosition();
    scheduleRender();
  }

  function setData(data) {
    const fingerprint = JSON.stringify([data.me, data.members, data.apps]);
    if (state.data && fingerprint === state.dataFingerprint) {
      state.lastDataAt = Date.now();
      return { ok: true, unchanged: true, apps: state.appIndex.size, members: state.memberIndex.size };
    }
    state.data = data;
    state.dataFingerprint = fingerprint;
    state.lastDataAt = Date.now();
    state.dataVersion++;
    state.appIndex = new Map();
    for (const [appid, owner, copies, canonicalType, isFree, excludedFromSharing] of data.apps || []) {
      const id = Number(appid);
      if (typeof isFree === 'boolean') state.freeStatuses.set(id, isFree);
      if (typeof excludedFromSharing === 'boolean') state.sharingStatuses.set(id, excludedFromSharing);
      state.appIndex.set(id, {
        owner: Number(owner) || 0,
        copies: Number(copies) || 1,
        // 旧快照没有类型字段时保持旧行为，避免宿主升级不同步时把计数清空。
        canonicalType: Number(canonicalType) || 1,
        isFree: state.freeStatuses.get(id) ?? null,
        excludedFromSharing: state.sharingStatuses.get(id) ?? null,
      });
    }
    state.memberIndex = new Map();
    for (const m of data.members || []) state.memberIndex.set(m.accountId, m);
    if (state.preferencesAccountId !== (data.me?.accountId ?? null)) {
      loadPreferences(data.me?.accountId ?? null);
    }
    scheduleRender(true);
    return { ok: true, apps: state.appIndex.size, members: state.memberIndex.size };
  }

  function setLenders(map) {
    let changed = false;
    for (const [appid, lenders] of Object.entries(map || {})) {
      if (JSON.stringify(state.lenders[appid]) === JSON.stringify(lenders)) continue;
      state.lenders[appid] = lenders;
      changed = true;
    }
    if (!changed) return Object.keys(state.lenders).length;
    state.lendersVersion++;
    scheduleRender(true);
    return Object.keys(state.lenders).length;
  }

  const freeRequests = new Set();
  const freeRetry = new Map(); // appid -> { attempts, nextAt }
  const freeQueue = [];
  let freeActive = 0;

  function pumpFreeRequests() {
    if (disposed) return;
    while (freeActive < 12 && freeQueue.length) {
      const appid = freeQueue.shift();
      freeActive++;
      Promise.resolve()
        .then(() => host.requestFreeStatus(appid))
        .then((result) => {
          if (disposed) return;
          const info = state.appIndex.get(appid);
          const isFree = typeof result === 'boolean' ? result : result?.isFree;
          const excluded = result?.excludedFromSharing;
          let changed = false;
          if (info && typeof isFree === 'boolean' && info.isFree !== isFree) {
            info.isFree = isFree;
            state.freeStatuses.set(appid, isFree);
            changed = true;
          }
          if (info && typeof excluded === 'boolean' && info.excludedFromSharing !== excluded) {
            info.excludedFromSharing = excluded;
            state.sharingStatuses.set(appid, excluded);
            changed = true;
          }
          if (changed) {
            state.dataVersion++;
            scheduleRender(true);
          }
          if (typeof isFree !== 'boolean' || typeof excluded !== 'boolean') {
            const attempts = (freeRetry.get(appid)?.attempts || 0) + 1;
            freeRetry.set(appid, { attempts, nextAt: Date.now() + 2000 * 2 ** (attempts - 1) });
          } else freeRetry.delete(appid);
        })
        .catch(() => {
          if (disposed) return;
          const attempts = (freeRetry.get(appid)?.attempts || 0) + 1;
          freeRetry.set(appid, { attempts, nextAt: Date.now() + 2000 * 2 ** (attempts - 1) });
        })
        .finally(() => {
          freeActive--;
          freeRequests.delete(appid);
          if (!disposed) pumpFreeRequests();
        });
    }
  }

  function requestFreeStatus(appid) {
    if (disposed) return;
    const info = state.appIndex.get(appid);
    const retry = freeRetry.get(appid);
    if (!host.requestFreeStatus || !info || (info.canonicalType !== 1 && info.canonicalType !== 2) || (info.isFree !== null && info.excludedFromSharing !== null) || freeRequests.has(appid) || (retry && (retry.attempts >= 3 || retry.nextAt > Date.now()))) return;
    freeRequests.add(appid);
    freeQueue.push(appid);
    pumpFreeRequests();
  }

  let ownedCountsCache = { key: '', value: null };

  /**
   * 每个成员「拥有」的游戏和软件数。
   *
   * 规则：
   *  1. 一个游戏多人都有就各算一份（不是只算 Steam 选定的主所有者）。
   *  2. 计入 Steam 标记为游戏（1）或软件（2）的条目；专用服务器和原声不混入。
   *  3. 免费应用以 Steam 的 bIsFreeApp 为准，不把 `number_of_copies` 当作可借副本。
   */
  function ownedCounts() {
    const key = `${state.dataVersion}|${state.lendersVersion}`;
    if (ownedCountsCache.key === key) return ownedCountsCache.value;

    const counts = Object.create(null);
    const freebies = Object.create(null);
    const unverified = { pending: 0, failed: 0 };
    const meId = state.data?.me?.accountId ?? null;

    for (const [appid, info] of state.appIndex) {
      const lenders = state.lenders[appid];
      if (info.canonicalType !== 1 && info.canonicalType !== 2) continue;
      if (info.isFree === true) {
        if (meId !== null) freebies[meId] = (freebies[meId] || 0) + 1;
        continue;
      }
      if (info.copies > 1 && !Array.isArray(lenders)) {
        unverified[lenders === null ? 'failed' : 'pending']++;
        continue;
      }
      const lenderIds = Array.isArray(lenders)
        ? lenders.map((l) => l.accountId).filter((id) => state.memberIndex.has(id))
        : [];

      if (info.owner === 0) {
        /*
         * 注意不能「先给自己 +1 再遍历 lenders」：自己名下时
         * GetAvailableLenders 也可能返回当前账号，
         * 那样自己会被算两遍。直接以 lenders 为准，它为空才退回自己。
         */
        const ids = lenderIds.length ? lenderIds : meId !== null ? [meId] : [];
        for (const id of ids) counts[id] = (counts[id] || 0) + 1;
        continue;
      }

      const ids = lenderIds.length ? lenderIds : [info.owner];
      for (const id of ids) {
        if (!state.memberIndex.has(id)) continue;
        counts[id] = (counts[id] || 0) + 1;
      }
    }

    const value = { counts, freebies, unverified };
    ownedCountsCache = { key, value };
    return value;
  }

  /** 某游戏在家庭库里的持有者（账号 ID 列表）。 */
  function holderIds(appid) {
    const info = state.appIndex.get(appid);
    const meId = state.data?.me?.accountId;
    if (info?.isFree === true) return meId != null && state.memberIndex.has(meId) ? [meId] : [];
    const withLenders = state.lenders[appid];
    const raw =
      Array.isArray(withLenders) && withLenders.length
        ? withLenders.map((l) => l.accountId)
        : info && info.owner
          ? [info.owner]
          : [];
    // 只留真家庭成员：本机登录过的小号也会出现在共享库账号甚至 lenders 里，
    // 但它不属于 Steam 家庭，不该参与角标与统计。
    return raw.filter((id) => state.memberIndex.has(id));
  }

  /** 自己独占的条目也属于自己的持有集合，不能只依据可借用者列表。 */
  function ownedByIds(appid) {
    const ids = holderIds(appid);
    const info = state.appIndex.get(appid);
    const meId = state.data?.me?.accountId;
    if (info?.owner === 0 && meId != null && state.memberIndex.has(meId) && !ids.includes(meId)) ids.push(meId);
    return ids;
  }

  function holderDetails(appid) {
    const info = state.appIndex.get(appid);
    const ids = holderIds(appid);
    const meId = state.data?.me?.accountId ?? null;
    const list = ids.map((id) => {
      const m = state.memberIndex.get(id);
      return {
        accountId: id,
        name: m?.nickname || m?.name || `账号 ${id}`,
        avatar: m?.avatar || '',
        isMe: meId !== null && id === meId,
      };
    });
    // 自己有这份游戏、但 lenders 没把自己列出来（自己独占或自己是主所有者）时补一条
    if (info && info.owner === 0 && !list.some((h) => h.isMe)) {
      const me = state.data?.me;
      list.unshift({
        accountId: 'me',
        name: me?.name || '我',
        avatar: me?.avatar || '',
        isMe: true,
      });
    }
    return { info, list };
  }

  // ---------------------------------------------------------------- 卡片识别
  const APPID_IN_SRC = /\/assets\/(\d+)\//;
  const anchorCache = new WeakMap(); // img 元素 -> { src, anchor }

  /** 从封面图往上找「卡片根」：不能被 overflow 裁剪、不是绝对定位、尺寸要和封面接近。 */
  function computeAnchor(img, imgRect) {
    // 库列表里的 20px 小图标：改找它所在的「整行」，角标贴到行尾
    if (imgRect.width <= 60) {
      let row = img.parentElement;
      for (let i = 0; i < 6 && row && row !== doc.body; i++, row = row.parentElement) {
        const cs = win.getComputedStyle(row);
        const r = row.getBoundingClientRect();
        if (
          r.width >= 200 &&
          r.height >= 18 &&
          r.height <= 48 &&
          cs.overflowX === 'visible' &&
          cs.overflowY === 'visible' &&
          cs.position !== 'absolute' &&
          cs.position !== 'fixed'
        ) {
          return row;
        }
      }
    }
    let node = img.parentElement;
    for (let i = 0; i < 8 && node && node !== doc.body; i++, node = node.parentElement) {
      const cs = win.getComputedStyle(node);
      const r = node.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue;
      const noClip = cs.overflowX === 'visible' && cs.overflowY === 'visible';
      const notAbs = cs.position !== 'absolute' && cs.position !== 'fixed';
      const fits =
        r.width >= imgRect.width &&
        r.width <= imgRect.width * 2.4 &&
        r.height >= imgRect.height * 0.85 &&
        r.height <= imgRect.height * 3;
      if (noClip && notAbs && fits) return node;
    }
    return null;
  }

  /** 已知的库卡片样式特征；用于在筛选后只剩少量卡片时仍能认出来。 */
  const knownCardKeys = new Set();

  function cardKey(anchor, rect) {
    return `${String(anchor.className || '')}#${Math.round(rect.width / 20)}`;
  }

  /** 收藏夹预览拼接多个不同游戏；单款游戏卡也可能含两张相同封面，不能仅按图片张数排除。 */
  function isCollectionOverviewCard(anchor) {
    let node = anchor;
    for (let i = 0; i < 9 && node && node !== doc.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.width > 280 || r.height > 280) continue;
      const text = String(node.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/\(\s*\d+\s*\)\s*$/.test(text)) continue;
      const ids = new Set();
      for (const cover of node.querySelectorAll('img[src*="/assets/"]')) {
        const m = APPID_IN_SRC.exec(cover.currentSrc || cover.src || '');
        if (m) ids.add(m[1]);
        if (ids.size > 1) return true;
      }
    }
    return false;
  }

  function findCards() {
    const raw = [];
    const seen = new Set();
    // 只处理视口附近：虚拟列表会渲染大量屏幕外的卡片，
    // 全部处理过一次要 28ms、峰值 50ms（滚动时明显掉帧），过滤后只剩视口内的几十张。
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const OVERSCAN = 180;
    let scanned = 0;
    for (const img of doc.querySelectorAll('img[src*="/assets/"]')) {
      const src = img.currentSrc || img.src || '';
      const m = APPID_IN_SRC.exec(src);
      if (!m) continue;
      const appid = Number(m[1]);
      // 商店、新闻或收藏拼图会复用同样的 CDN 路径；不在当前库中的 app 一律不是目标。
      if (!state.appIndex.has(appid)) continue;
      const ir = img.getBoundingClientRect();
      if (ir.width < 16 || ir.height < 16) continue;
      // Steam 会在游戏卡下叠一张透明的同款封面；角标只应贴在可见那张上。
      if (win.getComputedStyle(img.parentElement).opacity === '0') continue;
      // 排除详情页的 hero / logo 大图，它们不是库卡片
      if (ir.width > 460 || ir.height > 700) continue;
      if (
        ir.bottom < -OVERSCAN ||
        ir.top > vh + OVERSCAN ||
        ir.right < -OVERSCAN ||
        ir.left > vw + OVERSCAN
      ) {
        continue;
      }
      scanned++;

      let anchor = null;
      const cached = anchorCache.get(img);
      if (cached && cached.src === src && cached.anchor?.isConnected && cached.anchor.contains(img)) {
        anchor = cached.anchor;
      } else {
        anchor = computeAnchor(img, ir);
        anchorCache.set(img, { src, anchor });
      }
      if (!anchor || seen.has(anchor)) continue;
      const rect = anchor.getBoundingClientRect();
      if (rect.width < 60 || rect.height < 18) continue; // 太小的图标不值得贴角标

      if (isCollectionOverviewCard(anchor)) continue;

      /*
       * 左侧栏的「集合」不是游戏，不该贴角标。
       * 集合项（•创作 (12)、Ⅰ 肉鸽 (86)…）的行尾带 "(数字)" 计数，据此排除。
       */
      const rowText = String(anchor.innerText || '').replace(/\s+/g, ' ').trim();
      if (/\(\d+\)\s*$/.test(rowText)) continue;

      seen.add(anchor);
      raw.push({ appid, anchor, img, rect, key: cardKey(anchor, rect) });
    }
    state.stats.scanned = scanned;

    const list = doc.querySelector('.ReactVirtualized__Grid.ReactVirtualized__List');
    const libraryRightEdge = list?.getBoundingClientRect().right || 0;
    const kept = familyLensKeepCards(raw, knownCardKeys, libraryRightEdge, currentDetailAppId());
    // 卡片样式随 Steam 改版会变，定期忘掉旧特征
    if (knownCardKeys.size > 60) knownCardKeys.clear();
    return kept;
  }

  /**
   * 卡片根如果是 static 定位，角标的 absolute 就会跑到更外层去，
   * 所以补一个 relative；用属性打标记而不是记在 Set 里，避免长跑时攒住已回收的 DOM 节点。
   */
  function markAnchor(el) {
    if (win.getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
      el.dataset.flPos = '1';
    }
  }

  /** 清理 React 复用节点留下的角标和筛选样式，尤其是游戏卡变成收藏总览卡时。 */
  function cleanStaleCards(cards) {
    const active = new Set(cards.map((c) => c.anchor));
    for (const el of doc.querySelectorAll('[data-fl-card]')) {
      if (active.has(el)) continue;
      el.querySelector(':scope > .fl-badge')?.remove();
      delete el.dataset.flHidden;
      delete el.dataset.flCard;
      if (el.dataset.flPos) {
        el.style.position = '';
        delete el.dataset.flPos;
      }
    }
  }

  function buildBadge(appid, wide = false) {
    const { info, list } = holderDetails(appid);
    const copies = info?.copies || 1;
    const lenders = state.lenders[appid];
    const isFree = info?.isFree === true;
    const shared = info?.owner !== 0 || (copies > 1 && Array.isArray(lenders) && lenders.length > 0);
    const badge = doc.createElement('div');
    badge.className = 'fl-badge' + (!isFree && shared && copies > 1 ? ' is-multi' : '') + (wide ? ' fl-badge-row' : '');
    badge.dataset.flAppid = String(appid);

    const avatars = doc.createElement('div');
    avatars.className = 'fl-avatars';
    for (const holder of list.slice(0, 3)) {
      if (holder.avatar) {
        const a = doc.createElement('img');
        a.src = AVATAR_URL(holder.avatar);
        a.title = holder.name + (holder.isMe ? '（你）' : '');
        a.referrerPolicy = 'no-referrer';
        avatars.appendChild(a);
        continue;
      }
      const span = doc.createElement('span');
      span.className = 'fl-more';
      span.textContent = holder.isMe ? '我' : (holder.name || '?').slice(0, 1);
      span.title = holder.name;
      avatars.appendChild(span);
    }
    if (list.length > 3) {
      const more = doc.createElement('span');
      more.className = 'fl-more';
      more.textContent = '+' + (list.length - 3);
      more.title = list.slice(3).map((h) => h.name).join('、');
      avatars.appendChild(more);
    }
    badge.appendChild(avatars);

    const count = doc.createElement('span');
    count.className = 'fl-count';
    const unresolved = copies > 1 && !Array.isArray(lenders) && !isFree;
    count.textContent = isFree ? '免费' : unresolved ? (lenders === null ? '查询失败' : '查询中') : `${shared ? copies : 1} 份`;
    badge.appendChild(count);

    if (list.length) badge.title = list.map((h) => h.name).join(' / ') + (isFree ? '　免费' : unresolved ? '　持有者待确认' : `　共 ${shared ? copies : 1} 份`);
    return badge;
  }

  function renderBadges(cards) {
    let n = 0;
    for (const { appid, anchor, rect } of cards) {
      anchor.dataset.flCard = '1';
      const { info, list } = holderDetails(appid);
      requestFreeStatus(appid);
      // 自己独占的游戏/软件也标明本人；免费许可不冒充家庭副本。
      const visible = info && (info.canonicalType === 1 || info.canonicalType === 2) && list.length > 0;
      const existing = anchor.querySelector(':scope > .fl-badge');
      if (!visible) {
        if (existing) existing.remove();
        continue;
      }
      const wide = rect.width >= rect.height * 4;
      const lenderState = state.lenders[appid] === null ? 'failed' : Array.isArray(state.lenders[appid]) ? state.lenders[appid].length : 'pending';
      const key = `${appid}|${info.copies}|${info.isFree}|${lenderState}|${list.map((h) => h.accountId).join(',')}|${wide ? 'r' : 'c'}`;
      if (existing && existing.dataset.flKey === key) {
        n++;
        continue;
      }
      if (existing) existing.remove();
      markAnchor(anchor);
      const badge = buildBadge(appid, wide);
      badge.dataset.flKey = key;
      anchor.appendChild(badge);
      n++;
    }
    state.stats.badges = n;
  }

  // ---------------------------------------------------------------- 筛选
  function passFilter(appid) {
    if (!state.selectedMembers.length) return true;
    if (!state.appIndex.has(appid)) return false;
    const owners = ownedByIds(appid);
    return state.filterMode === 'intersection'
      ? state.selectedMembers.every((id) => owners.includes(id))
      : state.selectedMembers.some((id) => owners.includes(id));
  }

  const nativeFilterStore = host.nativeFilterStore || null;
  let managedHomeCollection = null;
  const managedNativeFilters = new WeakSet();
  let allowedCache = { key: '', ids: new Set(), signature: '' };
  let nativeAppliedKey = '';
  let nativeFilterReady = false;
  let homeOriginalIds = null;
  let homeAppliedIds = null;
  let homeAppliedKey = '';

  function selectionKey() {
    return `${state.filterMode}|${[...state.selectedMembers].sort((a, b) => a - b).join(',')}`;
  }

  function allowedApps() {
    const key = `${selectionKey()}|${state.dataVersion}|${state.lendersVersion}`;
    if (allowedCache.key === key) return allowedCache;
    const ids = familyLensAllowedIds(state.appIndex, state.selectedMembers, state.filterMode, ownedByIds);
    allowedCache = { key, ids, signature: `${selectionKey()}|${[...ids].join(',')}` };
    return allowedCache;
  }

  /** Steam 自己根据筛选对象重建左右列表及网格；只换内存对象，不保存或改动收藏夹。 */
  function applyNativeFilter() {
    const store = nativeFilterStore;
    if (!store?.InitializeAppFilter || !store.m_currentAppFilter || !store.m_collectionsAppFilter) return false;
    const left = store.m_currentAppFilter;
    const right = store.m_collectionsAppFilter;
    const makeFilter = (source, ids) => {
      const clone = store.InitializeAppFilter(source.ToStorageFormat(), true);
      if (!clone || typeof clone.MatchesImpl !== 'function') return null;
      if (ids) {
        const original = clone.MatchesImpl;
        clone.MatchesImpl = function (app) {
          return original.call(this, app) && ids.has(app.appid);
        };
        managedNativeFilters.add(clone);
      }
      return clone;
    };

    if (!state.selectedMembers.length) {
      if (!managedNativeFilters.has(left) && !managedNativeFilters.has(right)) return true;
      const cleanLeft = managedNativeFilters.has(left) ? makeFilter(left, null) : left;
      const cleanRight = right === left ? cleanLeft : managedNativeFilters.has(right) ? makeFilter(right, null) : right;
      if (!cleanLeft || !cleanRight) return false;
      store.m_currentAppFilter = cleanLeft;
      store.m_collectionsAppFilter = cleanRight;
      nativeAppliedKey = '';
      return true;
    }

    const allowed = allowedApps();
    if (
      nativeAppliedKey === allowed.signature &&
      managedNativeFilters.has(left) &&
      managedNativeFilters.has(right)
    ) return true;
    const nextLeft = makeFilter(left, allowed.ids);
    const nextRight = right === left ? nextLeft : makeFilter(right, allowed.ids);
    if (!nextLeft || !nextRight) return false;
    store.m_currentAppFilter = nextLeft;
    store.m_collectionsAppFilter = nextRight;
    nativeAppliedKey = allowed.signature;
    return true;
  }

  function sameIds(a, b) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, i) => id === b[i]);
  }

  /** 库主页「所有游戏」是独立的集合，不读取 m_collectionsAppFilter。只改内存并保留恢复副本。 */
  function syncHomeCollection() {
    const collection = host.getNativeHomeCollection?.() || host.nativeHomeCollection || null;
    if (!collection?.SetApps || !Array.isArray(collection.m_rgApps)) return;
    if (collection !== managedHomeCollection) {
      if (managedHomeCollection && homeOriginalIds) {
        const oldCurrent = managedHomeCollection.m_rgApps;
        const restored = sameIds(oldCurrent, homeAppliedIds)
          ? homeOriginalIds : familyLensMergeHomeIds(homeOriginalIds, oldCurrent, state.appIndex);
        if (!sameIds(oldCurrent, restored)) {
          managedHomeCollection.SetApps(restored);
          managedHomeCollection.ClearAppCounts?.();
        }
      }
      managedHomeCollection = collection;
      homeOriginalIds = null;
      homeAppliedIds = null;
      homeAppliedKey = '';
    }
    const current = collection.m_rgApps;
    if (!state.selectedMembers.length) {
      if (homeOriginalIds) {
        const restored = sameIds(current, homeAppliedIds)
          ? homeOriginalIds : familyLensMergeHomeIds(homeOriginalIds, current, state.appIndex);
        if (!sameIds(current, restored)) {
          collection.SetApps(restored);
          collection.ClearAppCounts?.();
        }
      }
      homeOriginalIds = null;
      homeAppliedIds = null;
      homeAppliedKey = '';
      return;
    }

    // Steam 自己更新了集合时，重新以它的最新完整列表为基准，不能用旧快照盖回去。
    if (!homeOriginalIds) {
      homeOriginalIds = [...current];
      homeAppliedKey = '';
    } else if (!homeAppliedIds || !sameIds(current, homeAppliedIds)) {
      homeOriginalIds = familyLensMergeHomeIds(homeOriginalIds, current, state.appIndex);
      homeAppliedKey = '';
    }
    const allowed = allowedApps();
    if (homeAppliedKey === allowed.signature) return;
    const filtered = homeOriginalIds.filter((id) => allowed.ids.has(id));
    if (!sameIds(current, filtered)) {
      collection.SetApps(filtered);
      collection.ClearAppCounts?.();
    }
    homeAppliedIds = filtered;
    homeAppliedKey = allowed.signature;
    state.stats.homeAllGames = filtered.length;
  }

  function syncNativeFilter() {
    try {
      nativeFilterReady = applyNativeFilter();
      syncHomeCollection();
    } catch (e) {
      nativeFilterReady = false;
      console.warn('[family-lens] Steam 原生筛选不可用，回退到可逆隐藏', e);
    }
  }

  /**
   * Millennium 使用 Steam 原生筛选对象重排。其它宿主退回占位隐藏，
   * 不直接 display:none 破坏 React 虚拟列表。
   */
  function renderFilter(cards) {
    const native = nativeFilterReady;
    let hits = 0;
    for (const { appid, anchor } of cards) {
      const ok = passFilter(appid);
      anchor.dataset.flCard = '1';
      if (native || ok) {
        hits++;
        if (anchor.dataset.flHidden) {
          delete anchor.dataset.flHidden;
        }
      } else if (!anchor.dataset.flHidden) {
        anchor.dataset.flHidden = '1';
      }
    }
    state.stats.filterHits = hits;
  }

  function setFilter(value) {
    if (value === null) {
      state.selectedMembers = [];
    } else {
      const id = value === 'me' ? state.data?.me?.accountId : Number(value);
      if (!state.memberIndex.has(id)) return;
      state.selectedMembers = state.selectedMembers.includes(id)
        ? state.selectedMembers.filter((x) => x !== id)
        : [...state.selectedMembers, id];
    }
    syncNativeFilter();
    scheduleRender(true);
    toast(state.selectedMembers.length ? `已筛选 ${state.selectedMembers.length} 位成员 · ${state.filterMode === 'intersection' ? '共同持有' : '总共持有'}` : '已显示全部游戏');
  }

  function setFilterMode(mode) {
    if (mode !== 'union' && mode !== 'intersection') return;
    state.filterMode = mode;
    syncNativeFilter();
    scheduleRender(true);
    if (state.selectedMembers.length) toast(mode === 'intersection' ? '共同持有：所选成员都拥有' : '总共持有：任一所选成员拥有');
  }

  // ---------------------------------------------------------------- 顶部成员筛选条
  const BAR_ID = 'fl-bar';
  const MEMBER_TOOLTIP_ID = 'fl-member-tooltip';
  function hideMemberTooltip() {
    doc.getElementById(MEMBER_TOOLTIP_ID)?.remove();
  }

  function showMemberTooltip(chip, content) {
    hideMemberTooltip();
    const tip = doc.createElement('div');
    tip.id = MEMBER_TOOLTIP_ID;
    tip.className = 'fl-member-tooltip';
    tip.textContent = content;
    doc.body.appendChild(tip);
    const position = familyLensTooltipGeometry(chip.getBoundingClientRect(), {
      width: tip.offsetWidth, height: tip.offsetHeight,
    }, { width: win.innerWidth, height: win.innerHeight });
    tip.style.left = `${position.left}px`;
    tip.style.top = `${position.top}px`;
  }
  // 成员总览是核心入口，不保存折叠状态。此前一个很小的“家庭”图标会被误认为
  // 总览消失，且热重载后仍会沿用这个状态。
  try {
    win.localStorage.removeItem('familyLens.barCollapsed');
  } catch (e) {
    /* 忽略 */
  }

  /** 只有库页面 / 游戏详情页才显示我们的界面，商店、社区、好友列表里不打扰。 */
  function isLibraryVisible() {
    if (state.stats.cards > 0) return true;
    if (doc.querySelector('.ReactVirtualized__Grid, .ReactVirtualized__List')) return true;
    if (doc.querySelector('img[src*="library_hero"]')) return true;
    return false;
  }

  const SETTINGS_ID = 'fl-settings-overlay';
  function openSettings() {
    const old = doc.getElementById(SETTINGS_ID);
    if (old) { old.remove(); return; }
    const overlay = doc.createElement('div');
    overlay.id = SETTINGS_ID;
    overlay.className = 'fl-settings-overlay';
    const dialog = doc.createElement('div');
    dialog.className = 'fl-settings-dialog';
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
    overlay.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') overlay.remove(); });

    const head = doc.createElement('div');
    head.className = 'fl-settings-head';
    const title = doc.createElement('h3');
    title.textContent = '家庭库透视 · 显示设置';
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.addEventListener('click', () => overlay.remove());
    head.append(title, close);
    dialog.appendChild(head);

    const select = (label, key, choices) => {
      const row = doc.createElement('div');
      row.className = 'fl-settings-row';
      const caption = doc.createElement('span');
      caption.textContent = label;
      const field = doc.createElement('select');
      field.setAttribute('aria-label', label);
      for (const [value, text] of choices) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = text;
        field.appendChild(option);
      }
      field.value = String(state.preferences[key]);
      field.addEventListener('change', () => updatePreferences({ [key]: field.value }));
      row.append(caption, field);
      dialog.appendChild(row);
      return field;
    };
    const range = (label, key, min, max, suffix) => {
      const row = doc.createElement('div');
      row.className = 'fl-settings-row';
      const caption = doc.createElement('span');
      caption.textContent = label;
      const control = doc.createElement('div');
      control.className = 'fl-range-control';
      const field = doc.createElement('input');
      field.type = 'range';
      field.setAttribute('aria-label', label);
      field.min = String(min);
      field.max = String(max);
      field.value = String(state.preferences[key]);
      const value = doc.createElement('span');
      value.className = 'fl-range-value';
      value.textContent = `${field.value}${suffix}`;
      field.addEventListener('input', () => {
        value.textContent = `${field.value}${suffix}`;
        updatePreferences({ [key]: Number(field.value) });
      });
      control.append(field, value);
      row.append(caption, control);
      dialog.appendChild(row);
      return field;
    };

    select('详情面板位置', 'placement', [
      ['follow', '随封面滚动'], ['sticky', '右上角 · 滚动吸附'],
      ['hidden', '不显示详情面板'],
    ]);
    select('面板密度', 'density', [['standard', '标准'], ['compact', '紧凑']]);
    const verticalField = range('垂直偏移', 'verticalInset', 0, 240, 'px');
    const horizontalField = range('水平偏移', 'horizontalInset', 0, 200, 'px');
    range('背景不透明度', 'opacity', 65, 100, '%');
    const avatarRow = doc.createElement('div');
    avatarRow.className = 'fl-settings-row';
    const avatarCaption = doc.createElement('span');
    avatarCaption.textContent = '成员头像';
    const avatarLabel = doc.createElement('label');
    const avatarCheck = doc.createElement('input');
    avatarCheck.type = 'checkbox';
    avatarCheck.checked = state.preferences.showAvatars;
    avatarCheck.addEventListener('change', () => updatePreferences({ showAvatars: avatarCheck.checked }));
    avatarLabel.append(avatarCheck, doc.createTextNode('显示'));
    avatarRow.append(avatarCaption, avatarLabel);
    dialog.appendChild(avatarRow);

    const note = doc.createElement('p');
    note.className = 'fl-settings-note';
    note.textContent = '设置仅保存在当前 Steam 账号的本机客户端。0px 对齐右上角；垂直偏移增加向下，水平偏移增加向左。吸附模式随封面移动，滚动后停在顶栏下方。';
    dialog.appendChild(note);
    const reset = doc.createElement('button');
    reset.type = 'button';
    reset.textContent = '恢复默认';
    reset.addEventListener('click', () => {
      updatePreferences(familyLensNormalizePreferences(null));
      overlay.remove();
      openSettings();
    });
    dialog.appendChild(reset);
    doc.body.appendChild(overlay);
    close.focus();
    verticalField.disabled = state.preferences.placement === 'hidden';
    horizontalField.disabled = state.preferences.placement === 'hidden';
    dialog.querySelector('select').addEventListener('change', (ev) => {
      verticalField.disabled = ev.target.value === 'hidden';
      horizontalField.disabled = ev.target.value === 'hidden';
    });
  }

  function renderBar() {
    if (!state.data) return;
    let bar = doc.getElementById(BAR_ID);
    const members = state.data.members || [];
    // 只有自己一个人（没加入任何 Steam 家庭，或家庭数据还没加载）时，这条没有意义
    if (!isLibraryVisible() || members.length <= 1) {
      hideMemberTooltip();
      if (bar) bar.style.display = 'none';
      return;
    }
    const headerHost = doc.querySelector('.TopBar .SuperNavBar .SuperNav');
    const mount = headerHost || doc.body;
    if (!bar) {
      bar = doc.createElement('div');
      bar.id = BAR_ID;
      bar.className = 'fl-bar';
    }
    if (bar.parentElement !== mount) mount.appendChild(bar);
    bar.classList.toggle('fl-header', !!headerHost);
    bar.style.display = '';
    bar.classList.remove('fl-collapsed');
    const { counts, freebies, unverified } = ownedCounts();
    /*
     * 计数必须进签名：lenders 是分批推送的，数字会一路变，
     * 签名里不带计数的话这条就永远停在第一次渲染的旧数字上。
     */
    const sig =
      members.map((m) => m.accountId).join(',') +
      '|' +
      selectionKey() +
      '|' +
      members.map((m) => `${counts[m.accountId] ?? 0}:${freebies[m.accountId] ?? 0}`).join(',') +
      `|${unverified.pending}:${unverified.failed}`;
    if (bar.dataset.flSig === sig) return;
    bar.dataset.flSig = sig;
    hideMemberTooltip();
    bar.textContent = '';

    const coverButton = (button) => {
      const hit = doc.createElement('span');
      hit.className = 'fl-hit';
      hit.setAttribute('aria-hidden', 'true');
      button.appendChild(hit);
    };

    const title = doc.createElement('span');
    title.className = 'fl-title';
    title.textContent = '家庭库';
    title.title = `家庭成员筛选 · ${unverified.pending} 个多份条目查询中，${unverified.failed} 个查询失败（未计入成员数）`;
    bar.appendChild(title);

    const makeChip = (label, avatar, value, extraClass = '') => {
      const chip = doc.createElement('button');
      chip.className = 'fl-chip' + extraClass + (state.selectedMembers.includes(value) ? ' fl-on' : '');
      chip.title = label;
      if (avatar) {
        const img = doc.createElement('img');
        img.src = AVATAR_URL(avatar);
        img.referrerPolicy = 'no-referrer';
        img.draggable = false;
        chip.appendChild(img);
      } else {
        chip.textContent = label.slice(0, 1);
        chip.style.fontSize = '11px';
      }
      chip.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setFilter(value);
      }, true);
      return chip;
    };

    const all = doc.createElement('button');
    all.className = 'fl-chip fl-all' + (!state.selectedMembers.length ? ' fl-on' : '');
    all.title = '显示全部（清除筛选）';
    all.textContent = '全部';
    all.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setFilter(null);
    }, true);
    coverButton(all);
    bar.appendChild(all);

    for (const [mode, label] of [['intersection', '共同持有'], ['union', '总共持有']]) {
      const button = doc.createElement('button');
      button.className = 'fl-mode' + (state.filterMode === mode ? ' fl-on' : '');
      button.textContent = label;
      button.title = mode === 'intersection' ? '所选成员都拥有（交集）' : '任一所选成员拥有（并集）';
      button.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setFilterMode(mode);
      }, true);
      coverButton(button);
      bar.appendChild(button);
    }

    for (const m of members) {
      const label = (m.nickname || m.name || `账号 ${m.accountId}`) + (m.isMe ? '（你）' : '');
      const chip = makeChip(label, m.avatar, m.accountId);
      const owned = counts[m.accountId] ?? 0;
      const free = freebies[m.accountId] ?? 0;
      const n = doc.createElement('span');
      n.className = 'fl-n';
      n.textContent = String(owned);
      chip.appendChild(n);
      coverButton(chip);
      // 提示层挂在 body，避免 Steam 顶栏的横向滚动容器裁切或错位。
      const tooltipText =
        `${label} · 拥有 ${owned} 个游戏/软件` +
        (free ? `（另有 ${free} 个免费游戏/附加内容未计入）` : '');
      chip.removeAttribute('title');
      chip.setAttribute('aria-label', tooltipText);
      chip.addEventListener('mouseenter', () => showMemberTooltip(chip, tooltipText));
      chip.addEventListener('focus', () => showMemberTooltip(chip, tooltipText));
      chip.addEventListener('mouseleave', hideMemberTooltip);
      chip.addEventListener('blur', hideMemberTooltip);
      chip.addEventListener('click', hideMemberTooltip);
      bar.appendChild(chip);
    }
    const settings = doc.createElement('button');
    settings.className = 'fl-settings-button';
    settings.type = 'button';
    settings.textContent = '⚙';
    settings.title = '家庭库透视显示设置';
    settings.setAttribute('aria-label', '家庭库透视显示设置');
    settings.addEventListener('click', (ev) => { ev.stopPropagation(); openSettings(); }, true);
    coverButton(settings);
    bar.appendChild(settings);
  }

  // ---------------------------------------------------------------- 详情页面板
  const PANEL_ID = 'fl-panel';
  let panelHero = null;
  let panelTrackingFrame = null;
  let topBarNode = null;
  let urlBarNode = null;

  function stopPanelTracking() {
    panelHero = null;
    if (panelTrackingFrame !== null) win.cancelAnimationFrame(panelTrackingFrame);
    panelTrackingFrame = null;
  }

  function detailOcclusionBottom(heroRect, topBarBottom, panelWidth) {
    // Steam 的游戏详情操作栏在滚动后会贴在主顶栏下方；只看 .TopBar 会把面板放到它背后。
    const x = Math.min(win.innerWidth - 24, Math.max(24,
      heroRect.right - state.preferences.horizontalInset - panelWidth / 2));
    const y = Math.min(win.innerHeight - 1, Math.max(0, topBarBottom + 24));
    let found = topBarBottom;
    for (const layer of doc.elementsFromPoint?.(x, y) || []) {
      if (layer.closest?.('#fl-panel,#fl-bar,#fl-settings-overlay')) continue;
      let node = layer;
      for (let i = 0; i < 12 && node && node !== doc.body; i++, node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (style.position !== 'sticky' && style.position !== 'fixed') continue;
        const rect = node.getBoundingClientRect();
        if (rect.top >= topBarBottom - 16 && rect.bottom <= topBarBottom + 170 &&
            rect.height >= 30 && rect.width >= 200) {
          found = Math.max(found, rect.bottom);
        }
      }
    }
    // Steam 可能以 transform 而非 sticky 定位操作栏；只有封面底部接近顶栏时才保留安全区。
    return found > topBarBottom ? found
      : heroRect.bottom <= topBarBottom + 64 ? topBarBottom + 64 : topBarBottom;
  }

  function syncPanelPosition() {
    const panel = doc.getElementById(PANEL_ID);
    if (!panel || !panelHero || !doc.contains(panelHero)) return;
    const heroRect = panelHero.getBoundingClientRect();
    if (!topBarNode || !doc.contains(topBarNode)) topBarNode = doc.querySelector('.TopBar');
    if (!urlBarNode || !doc.contains(urlBarNode)) urlBarNode = doc.querySelector('.URLBarReplacement');
    const headerBottom = Math.max(
      topBarNode?.getBoundingClientRect().bottom || 0,
      urlBarNode?.getBoundingClientRect().bottom || 0,
    );
    const occlusionBottom = detailOcclusionBottom(heroRect, headerBottom, panel.offsetWidth);
    const geometry = familyLensPanelGeometry(heroRect, {
      width: win.innerWidth, height: win.innerHeight, headerBottom, occlusionBottom,
    }, panel.offsetHeight, state.preferences);
    const positionSig = `${geometry.top}|${geometry.right}|${geometry.clipTop}|${geometry.hidden}|${state.preferences.opacity}`;
    if (panel.dataset.flPositionSig === positionSig) return;
    panel.dataset.flPositionSig = positionSig;
    const set = (property, value) => { if (panel.style[property] !== value) panel.style[property] = value; };
    set('top', `${geometry.top}px`);
    set('right', `${geometry.right}px`);
    set('clipPath', geometry.clipTop ? `inset(${geometry.clipTop}px 0 0 0)` : '');
    set('visibility', geometry.hidden ? 'hidden' : 'visible');
    const opacity = String(state.preferences.opacity / 100);
    if (panel.style.getPropertyValue('--fl-panel-opacity') !== opacity) {
      panel.style.setProperty('--fl-panel-opacity', opacity);
    }
  }

  function trackPanel() {
    panelTrackingFrame = null;
    if (disposed || !panelHero || !doc.contains(panelHero) || !doc.getElementById(PANEL_ID)) return;
    syncPanelPosition();
    if (state.preferences.placement === 'follow' || state.preferences.placement === 'sticky') {
      panelTrackingFrame = win.requestAnimationFrame(trackPanel);
    }
  }

  function schedulePanelPosition() {
    if (panelTrackingFrame === null && panelHero) panelTrackingFrame = win.requestAnimationFrame(trackPanel);
  }

  function currentDetailHero() {
    const fromHash = /\/library\/app\/(\d+)/.exec(win.location.hash || '');
    /*
     * Steam 当前版本的库详情页不会写入 hash。不能再用任意 logo / 封面兜底：
     * 收藏夹和库主页也会预加载第一款游戏的这些资源。只有可见的大 hero 与
     * 同 app 的详情竖图同时存在，才是实际打开的游戏详情页。
     */
    for (const hero of doc.querySelectorAll('img[src*="library_hero"]')) {
      const src = hero.currentSrc || hero.src || '';
      const match = APPID_IN_SRC.exec(src);
      if (!match) continue;
      const rect = hero.getBoundingClientRect();
      if (rect.width < 460 || rect.height < 180 || win.getComputedStyle(hero).visibility === 'hidden') continue;
      const appid = Number(match[1]);
      if (fromHash && Number(fromHash[1]) !== appid) continue;
      if (fromHash) return { appid, hero };
      const hasPortrait = [...doc.querySelectorAll(`img[src*="/assets/${appid}/"]`)].some((img) => {
        const portraitSrc = img.currentSrc || img.src || '';
        const standard = portraitSrc.includes('library_600x900');
        const capsule = portraitSrc.includes('library_capsule');
        if (!standard && !capsule) return false;
        const r = img.getBoundingClientRect();
        if (r.width < 60 || r.height < 90 || win.getComputedStyle(img).visibility === 'hidden') return false;
        // 软件常用 library_capsule 而不是 600x900；要求它位于横幅下方的详情栏，
        // 防止把集合网格中的软件封面当作当前详情页。
        return standard || (r.x >= rect.x && r.x < rect.x + 300 && r.y >= rect.y && r.y < rect.bottom + 240);
      });
      if (hasPortrait) return { appid, hero };
    }
    return null;
  }

  function currentDetailAppId() {
    return currentDetailHero()?.appid ?? null;
  }

  function renderPanel() {
    const detail = currentDetailHero();
    const appid = detail?.appid;
    const existing = doc.getElementById(PANEL_ID);
    if (!appid || !state.data || !state.appIndex.has(appid)) {
      if (existing) existing.remove();
      stopPanelTracking();
      return;
    }
    const { info, list } = holderDetails(appid);
    requestFreeStatus(appid);
    // 不属于 Steam 家庭的共享游戏（例如本机小号的独立共享库）不显示这个面板
    if (!list.length && info.owner !== 0) {
      if (existing) existing.remove();
      stopPanelTracking();
      return;
    }

    let panel = existing;
    if (!panel) {
      panel = doc.createElement('div');
      panel.id = PANEL_ID;
      panel.className = 'fl-panel';
    }
    if (panel.parentElement !== doc.body) doc.body.appendChild(panel);
    panel.classList.toggle('fl-compact', state.preferences.density === 'compact');
    panel.classList.toggle('fl-no-avatars', !state.preferences.showAvatars);
    panelHero = detail.hero;
    schedulePanelPosition();
    const lenderState = Array.isArray(state.lenders[appid]) ? `known:${state.lenders[appid].length}` : state.lenders[appid] === null ? 'failed' : 'pending';
    const sig = `${appid}|${info.copies}|${info.isFree}|${info.excludedFromSharing}|${lenderState}|${list.map((h) => h.accountId).join(',')}`;
    if (panel.dataset.flSig === sig) return;
    panel.dataset.flSig = sig;
    panel.textContent = '';

    // 空的可借成员列表不能用来判定免费：付费但被禁止家庭共享的游戏也会返回空。
    // 免费与不可共享分别使用 Steam 详情的两个明确标记。
    const rawLenders = state.lenders[appid];
    const lendersKnown = Array.isArray(rawLenders);
    const hasLenders = lendersKnown && rawLenders.length > 0;
    const noLender = lendersKnown && !hasLenders && info.owner === 0 && info.copies > 1;
    const isFree = info.isFree === true;
    const visibleCopies = info.owner === 0 && noLender ? 1 : info.copies;

    const h = doc.createElement('h4');
    h.textContent = isFree ? '免费游戏或软件' : `家庭库中共有 ${visibleCopies} 份`;
    panel.appendChild(h);

    const sub = doc.createElement('div');
    sub.className = 'fl-sub';
    sub.textContent = isFree
      ? '此游戏/软件为免费项目，不支持家庭共享'
      : info.copies > 1 && !lendersKnown
        ? lenderState === 'failed' ? '持有者查询失败；目前仅显示已知来源' : '持有者查询中；目前仅显示已知来源'
      : list.length
        ? `由 ${list.length} 位成员持有`
        : info.owner === 0
          ? '仅你的库拥有（家庭内无重复）'
          : '家庭共享来源';
    panel.appendChild(sub);

    if (!isFree && info.excludedFromSharing === true) {
      const notice = doc.createElement('div');
      notice.className = 'fl-restrict';
      notice.textContent = '此游戏/软件为付费项目，且不支持家庭共享';
      panel.appendChild(notice);
    }

    for (const holder of list) {
      const row = doc.createElement('div');
      row.className = 'fl-holder';
      if (holder.avatar) {
        const img = doc.createElement('img');
        img.src = AVATAR_URL(holder.avatar);
        img.referrerPolicy = 'no-referrer';
        row.appendChild(img);
      } else {
        const span = doc.createElement('span');
        span.style.cssText =
          'width:22px;height:22px;border-radius:50%;background:#3d5a80;display:flex;align-items:center;justify-content:center;font-size:10px';
        span.textContent = holder.isMe ? '我' : (holder.name || '?').slice(0, 1);
        row.appendChild(span);
      }
      const label = doc.createElement('span');
      label.textContent = holder.name + (holder.isMe ? '（你）' : '');
      row.appendChild(label);
      panel.appendChild(row);
    }

  }

  // ---------------------------------------------------------------- 提示条
  let toastTimer = null;
  function toast(text) {
    let el = doc.getElementById('fl-toast');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'fl-toast';
      el.className = 'fl-toast';
      doc.body.appendChild(el);
    }
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2600);
  }

  // ---------------------------------------------------------------- 注入到原生「库筛选条件」面板
  const NATIVE_CLS = 'fl-native-group';

  /** 定位原生筛选面板的分组列容器：靠「特色」这个分组标题反查，不依赖 hash 类名。 */
  let cachedColumn = null;
  let lastFilterPanelScanAt = 0;
  function findFilterPanelColumn() {
    if (cachedColumn && doc.contains(cachedColumn) && cachedColumn.childElementCount >= 2) return cachedColumn;
    cachedColumn = null;
    if (Date.now() - lastFilterPanelScanAt < 1200) return null;
    lastFilterPanelScanAt = Date.now();
    const anchor = [...doc.querySelectorAll('div,span')].find(
      (e) =>
        (e.textContent || '').trim() === '特色' &&
        e.childElementCount <= 1 &&
        e.getBoundingClientRect().width > 10,
    );
    if (!anchor) return null;
    const group = anchor.parentElement;
    const column = group && group.parentElement;
    if (!column || column.childElementCount < 2) return null;
    cachedColumn = column;
    return column;
  }

  function buildNativeGroup() {
    const members = state.data?.members || [];
    const { counts: nativeCounts, freebies: nativeFreebies } = ownedCounts();

    const group = doc.createElement('div');
    group.className = NATIVE_CLS;
    group.style.cssText = 'display:flex;flex-direction:column;min-width:104px;';

    const title = doc.createElement('div');
    title.textContent = '家庭成员';
    title.style.cssText = 'font-size:11px;color:#8f98a0;letter-spacing:.4px;margin-bottom:5px;';
    group.appendChild(title);

    const modes = doc.createElement('div');
    modes.style.cssText = 'display:flex;gap:3px;margin-bottom:5px;';
    for (const [mode, label] of [['intersection', '共同持有'], ['union', '总共持有']]) {
      const button = doc.createElement('button');
      button.className = 'fl-mode' + (state.filterMode === mode ? ' fl-on' : '');
      button.textContent = label;
      button.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        setFilterMode(mode);
      });
      modes.appendChild(button);
    }
    group.appendChild(modes);

    const list = doc.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:1px;';

    for (const m of members) {
      const active = state.selectedMembers.includes(m.accountId);
      const row = doc.createElement('div');
      row.dataset.flAccount = String(m.accountId);
      row.style.cssText =
        'display:flex;align-items:center;gap:7px;padding:2px 6px 2px 4px;border-radius:3px;cursor:pointer;' +
        'font-size:12px;line-height:20px;color:' +
        (active ? '#fff' : '#c7d5e0') +
        ';background:' +
        (active ? 'rgba(102,192,244,.20)' : 'transparent') +
        ';';

      const box = doc.createElement('span');
      box.style.cssText =
        'width:13px;height:13px;flex:0 0 13px;border-radius:2px;border:1px solid ' +
        (active ? '#66c0f4' : '#5a6b7a') +
        ';background:' +
        (active ? '#66c0f4' : 'transparent') +
        ';display:flex;align-items:center;justify-content:center;font-size:10px;color:#0e141b;';
      if (active) box.textContent = '✓';
      row.appendChild(box);

      const av = doc.createElement('img');
      av.src = AVATAR_URL(m.avatar);
      av.referrerPolicy = 'no-referrer';
      av.style.cssText = 'width:17px;height:17px;border-radius:50%;background:#2a3f5a;flex:0 0 17px;';
      row.appendChild(av);

      const nm = doc.createElement('span');
      nm.textContent = (m.nickname || m.name || `账号 ${m.accountId}`) + (m.isMe ? '（你）' : '');
      nm.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      row.appendChild(nm);

      const cnt = doc.createElement('span');
      const ownedCount = nativeCounts[m.accountId] ?? 0;
      const freeCount = nativeFreebies[m.accountId] ?? 0;
      cnt.textContent = String(ownedCount);
      cnt.style.cssText = 'font-size:11px;color:#8f98a0;';
      row.title =
         `${m.nickname || m.name || m.accountId} · 拥有 ${ownedCount} 个游戏/软件` +
        (freeCount ? `（另有 ${freeCount} 个免费游戏/附加内容未计入）` : '');
      row.appendChild(cnt);

      row.addEventListener('mouseenter', () => {
        if (!state.selectedMembers.includes(m.accountId)) row.style.background = 'rgba(255,255,255,.06)';
      });
      row.addEventListener('mouseleave', () => {
        if (!state.selectedMembers.includes(m.accountId)) row.style.background = 'transparent';
      });
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        setFilter(m.accountId);
      });
      list.appendChild(row);
    }

    group.appendChild(list);
    return group;
  }

  function renderNativeGroup() {
    if (!state.data) return;
    const column = findFilterPanelColumn();
    if (!column) return;
    const { counts: nativeCounts, freebies: nativeFree } = ownedCounts();
    // 同筛选条：计数变化也要触发重建，否则数字停在旧值
    const sig =
      (state.data.members || []).map((m) => m.accountId).join(',') +
      '|' +
      selectionKey() +
      '|' +
      (state.data.members || [])
        .map((m) => `${nativeCounts[m.accountId] ?? 0}:${nativeFree[m.accountId] ?? 0}`)
        .join(',');
    const existing = column.querySelector(':scope > .' + NATIVE_CLS);
    if (existing && existing.dataset.flSig === sig) return;
    if (existing) existing.remove();
    const group = buildNativeGroup();
    group.dataset.flSig = sig;
    column.appendChild(group);
  }

  // ---------------------------------------------------------------- 渲染调度
  // Steam 的 UI 变化极其频繁，这里做两层节流：合并同一轮变更 + 最小渲染间隔，
  // 避免 MutationObserver 与自身写入互相触发把主线程拖满。
  const MIN_RENDER_GAP = 300;
  let scheduled = false;
  let lastRenderAt = 0;
  let timer = null;
  let frame = null;

  function runRender() {
    scheduled = false;
    if (disposed) return;
    lastRenderAt = Date.now();
    const t0 = performance.now();
    // 注入器退出后不会再有新数据，超时就自己收摊，别在界面上留下过期内容
    if (state.data && state.lastDataAt && Date.now() - state.lastDataAt > 90000) {
      console.warn('[family-lens] 注入器已停止推送数据，自动清理界面');
      try {
        api.dispose();
      } catch (e) {
        /* 忽略 */
      }
      return;
    }
    try {
      ensureStyle();
      syncNativeFilter();
      const cards = findCards();
      state.stats.cards = cards.length;
      cleanStaleCards(cards);
      renderBar();
      renderBadges(cards);
      renderFilter(cards);
      renderPanel();
      renderNativeGroup();
    } catch (e) {
      console.warn('[family-lens] render failed', e);
    } finally {
      recordRenderCost(performance.now() - t0);
    }
  }

  /** 记录单次渲染耗时，用来确认插件没有拖慢 Steam（可在 diagnose 里查看）。 */
  function recordRenderCost(ms) {
    const s = state.stats;
    s.renderCount = (s.renderCount || 0) + 1;
    s.renderTotalMs = (s.renderTotalMs || 0) + ms;
    s.avgRenderMs = Math.round((s.renderTotalMs / s.renderCount) * 100) / 100;
    s.lastRenderMs = Math.round(ms * 100) / 100;
    s.maxRenderMs = Math.max(s.maxRenderMs || 0, Math.round(ms * 100) / 100);
  }

  function scheduleRender(immediate = false) {
    if (disposed) return;
    if (immediate) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (frame !== null) {
        win.cancelAnimationFrame(frame);
        frame = null;
      }
      runRender();
      return;
    }
    if (scheduled) return;
    scheduled = true;
    const wait = Math.max(0, MIN_RENDER_GAP - (Date.now() - lastRenderAt));
    timer = setTimeout(() => {
      timer = null;
      frame = win.requestAnimationFrame(() => {
        frame = null;
        runRender();
      });
    }, wait);
  }

  // 忽略插件自己的节点写入，避免角标/面板更新反过来触发全页扫描。
  const ownSelector = '#fl-bar,#fl-panel,#fl-member-tooltip,#fl-settings-overlay,#fl-toast,#fl-style,.fl-badge,.fl-native-group';
  const isOwnMutation = (mutation) => {
    if (mutation.target?.nodeType === 1 && mutation.target.closest?.(ownSelector)) return true;
    if (mutation.type !== 'childList') return false;
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && node.matches?.(ownSelector));
  };
  const observer = new win.MutationObserver((mutations) => {
    if (mutations.some((mutation) => !isOwnMutation(mutation))) scheduleRender();
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  // 定时器只是兜底（React 复用 DOM 却没触发 mutation 的情况），
  // 结构变化有 MutationObserver 兜着，所以这里可以放得比较宽，省掉空闲时的渲染。
  const tick = setInterval(() => scheduleRender(), 8000);
  const onNavigation = () => { hideMemberTooltip(); scheduleRender(true); };
  const onScroll = () => { hideMemberTooltip(); schedulePanelPosition(); scheduleRender(); };
  win.addEventListener('hashchange', onNavigation);
  win.addEventListener('resize', onNavigation);
  doc.addEventListener('scroll', onScroll, true);

  // ---------------------------------------------------------------- 对外接口
  let disposed = false;
  const api = {
    version: VERSION,
    get disposed() {
      return disposed;
    },
    setData,
    setLenders,
    setFilter,
    setFilterMode,
    refresh: () => scheduleRender(true),
    get data() {
      return state.data;
    },
    get stats() {
      return { ...state.stats, selectedMembers: [...state.selectedMembers], filterMode: state.filterMode,
        preferences: { ...state.preferences }, panelTracking: panelTrackingFrame !== null,
        nativeFilter: nativeFilterReady, lendersCached: Object.keys(state.lenders).length };
    },
    diagnose: () => {
      const cards = findCards();
      const { counts, freebies } = ownedCounts();
      // 抽几个多份游戏，看 lenders 到底有没有拿到、键对不对得上
      const sample = [];
      for (const [appid, info] of state.appIndex) {
        if (info.copies > 1 && sample.length < 6) {
          const raw = state.lenders[appid];
          sample.push({
            appid,
            copies: info.copies,
            owner: info.owner,
            lendersRaw: raw ? raw.length : null,
            lendersAccountIds: Array.isArray(raw) ? raw.map((l) => l.accountId) : null,
            inMemberIndex: Array.isArray(raw)
              ? raw.map((l) => state.memberIndex.has(l.accountId))
              : null,
          });
        }
      }
      return {
        hash: win.location.hash,
        href: String(win.location.href).slice(0, 80),
        dataReady: !!state.data,
        appCount: state.appIndex.size,
        memberCount: state.memberIndex.size,
        dataVersion: state.dataVersion,
        lendersVersion: state.lendersVersion,
        lendersCached: Object.keys(state.lenders).length,
        counts,
        freebies,
        lendersSample: sample,
        cards: cards.slice(0, 8).map((c) => {
          const r = c.anchor.getBoundingClientRect();
          return {
            appid: c.appid,
            anchorCls: String(c.anchor.className || '').slice(0, 48),
            box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            hasBadge: !!c.anchor.querySelector(':scope > .fl-badge'),
          };
        }),
        panel: (() => {
          const panel = doc.getElementById(PANEL_ID);
          const hero = panelHero?.getBoundingClientRect();
          const rect = panel?.getBoundingClientRect();
          return { present: !!panel, placement: state.preferences.placement,
            heroTop: hero ? Math.round(hero.top) : null,
            panelTop: rect ? Math.round(rect.top) : null,
            clipped: panel?.style.clipPath || '', tracking: panelTrackingFrame !== null };
        })(),
        stats: { ...state.stats, selectedMembers: [...state.selectedMembers], filterMode: state.filterMode, nativeFilter: nativeFilterReady },
        barPresent: !!doc.getElementById(BAR_ID),
      };
    },
    dispose: () => {
      if (disposed) return 'disposed';
      disposed = true;
      freeQueue.length = 0;
      observer.disconnect();
      clearInterval(tick);
      clearTimeout(timer);
      if (frame !== null) win.cancelAnimationFrame(frame);
      clearTimeout(toastTimer);
      stopPanelTracking();
      hideMemberTooltip();
      win.removeEventListener('hashchange', onNavigation);
      win.removeEventListener('resize', onNavigation);
      doc.removeEventListener('scroll', onScroll, true);
      state.selectedMembers = [];
      try {
        applyNativeFilter();
        syncHomeCollection();
      } catch (e) {
        console.warn('[family-lens] 恢复 Steam 原生筛选失败', e);
      }
      // 恢复被我们改过定位的元素
      doc.querySelectorAll('[data-fl-pos]').forEach((el) => {
        el.style.position = '';
        delete el.dataset.flPos;
      });
      // 移除所有注入物（含塞进原生筛选面板里的「家庭成员」分组）
      doc
        .querySelectorAll('.fl-badge, .fl-native-group, #fl-bar, #fl-panel, #fl-settings-overlay, #fl-toast, #fl-style')
        .forEach((el) => el.remove());
      // 解除筛选造成的隐藏，否则库会一直空着
      doc.querySelectorAll('[data-fl-hidden]').forEach((el) => {
        delete el.dataset.flHidden;
      });
      doc.querySelectorAll('.fl-dimmed, .fl-hidden, .fl-filtered-out').forEach((el) => {
        el.classList.remove('fl-dimmed');
        el.classList.remove('fl-hidden');
        el.classList.remove('fl-filtered-out');
      });
      return 'disposed';
    },
  };

  scheduleRender(true);
  return api;
}
