/**
 * Steam 家庭库透视 —— Millennium 插件入口。
 *
 * 它跑在 Steam 的 SharedJSContext 里，和免安装原型最大的区别是：
 *   · 数据：appStore / SteamClient.FamilySharing / friendStore 随手可用，不必跨上下文搬运
 *   · 界面：通过 g_PopupManager 拿到主窗口的 document，交给与宿主无关的 core.ts
 *
 * core.ts 由 millennium/scripts/sync-core.mjs 从 src/ui/core.js 生成，
 * 所以两边的 DOM 逻辑是同一份代码，不会各自漂移。
 */
import { definePlugin } from 'millennium';
import { useEffect, useState } from 'react';
import { createFamilyLensUi } from './core';

const ACCOUNT_BASE = 76561197960265728n;
const NS = '__FAMILY_LENS__';
// Steam 的内部对象没有类型定义
const steam = window as any;

export type Member = {
  accountId: number;
  steamId: string;
  name: string;
  nickname: string;
  avatar: string;
  isMe: boolean;
};

export type AppInfo = { owner: number; copies: number; canonicalType: number; isFree: boolean | null; excludedFromSharing: boolean | null };

// ---------------------------------------------------------------- 主窗口定位

/** 在 popup 管理器里找出 Steam 主窗口 —— 库页面 DOM 就在它里面。 */
export function findMainDocument(): Document | null {
  const pm = steam.g_PopupManager;
  if (!pm || typeof pm.GetPopups !== 'function') return null;
  try {
    for (const popup of pm.GetPopups()) {
      const doc: Document | undefined = popup?.m_popup?.document;
      if (!doc || typeof doc.querySelector !== 'function') continue;
      if (doc.querySelector('.ReactVirtualized__Grid, img[src*="library_hero"]')) return doc;
    }
  } catch (e) {
    console.warn('[family-lens] 遍历 popup 失败', e);
  }
  return null;
}

// ---------------------------------------------------------------- 数据读取

function personaOf(accountId: number): Omit<Member, 'isMe'> {
  const cache = steam.friendStore?.m_mapPlayerCache;
  let v: any = null;
  try {
    v = cache?.get?.(accountId);
    if (v && typeof v.toJS === 'function') v = v.toJS();
  } catch (e) {
    /* 忽略 */
  }
  const p = v?.m_persona ?? {};
  return {
    accountId,
    steamId: (BigInt(accountId) + ACCOUNT_BASE).toString(),
    name: p.m_strPlayerName || `账号 ${accountId}`,
    nickname: v?.m_strNickname || '',
    avatar: p.m_strAvatarHash || '',
  };
}

/** 当前登录账号（从 loginStore 的登录用户头像路径里解析 SteamID64）。 */
export function readMe(): { accountId: number; name: string; avatar: string } | null {
  try {
    const users = steam.loginStore?.m_vecLoginUsers ?? [];
    const cur = users[0];
    const m = cur?.avatarUrl ? String(cur.avatarUrl).match(/(7656119\d{10})/) : null;
    if (!m) return null;
    const accountId = Number(BigInt(m[1]) - ACCOUNT_BASE);
    const persona = personaOf(accountId);
    return { accountId, name: persona.name || cur.personaName || '', avatar: persona.avatar };
  } catch (e) {
    return null;
  }
}

/** 家庭成员 = 家庭库账号（剔除小号）+ 自己。 */
export function readMembers(): Member[] {
  const appStore = steam.appStore;
  if (!appStore) return [];
  const ids: number[] = Array.isArray(appStore.sharedLibraryAccountIds)
    ? [...appStore.sharedLibraryAccountIds]
    : [];

  /*
   * 剔除「自带独立共享库」的账号。
   * appStore.sharedLibraryAccountIds 其实是「本机可访问的共享库账号」，混了两类：
   *   · Steam 家庭的成员          —— 游戏并进 shared-familygroup 集合
   *   · 本机登录过的其它账号(小号) —— 各自带一个 shared-<accountid> 集合
   * 一些本机曾登录的账号会带有独立共享库集合；按集合结构排除，
   * 不依赖任何用户的具体账号 ID。
   */
  const standalone = new Set<number>();
  try {
    for (const c of steam.collectionStore?.sharedLibrariesCollections ?? []) {
      const id = String(c?.m_strId || '');
      if (!id.startsWith('shared-') || id === 'shared-familygroup') continue;
      const n = Number(id.slice('shared-'.length));
      if (Number.isFinite(n) && n > 0) standalone.add(n);
    }
  } catch (e) {
    /* 忽略 */
  }

  const me = readMe();
  const members: Member[] = ids
    .filter((id) => !standalone.has(id))
    .map((id) => ({ ...personaOf(id), isMe: false }));
  const mine = me ? members.find((m) => m.accountId === me.accountId) : null;
  if (mine) mine.isMe = true;
  else if (me) members.push({ ...personaOf(me.accountId), isMe: true });
  return members;
}

/** appid -> { owner, copies, canonicalType }；owner 为 0 表示在自己名下。 */
export function readApps(): Map<number, AppInfo> {
  const out = new Map<number, AppInfo>();
  for (const a of steam.appStore?.allApps ?? []) {
    out.set(a.appid, {
      owner: a.owner_account_id || 0,
      copies: a.number_of_copies || 1,
      // 用于界面端统计：游戏与软件计入，专服和原声可被排除。
      canonicalType: a.canonicalAppType || a.app_type || 1,
      isFree: steam.appDetailsStore?.m_mapAppData?.get?.(a.appid)?.details?.bIsFreeApp ?? null,
      excludedFromSharing: steam.appDetailsStore?.m_mapAppData?.get?.(a.appid)?.details?.bIsExcludedFromSharing ?? null,
    });
  }
  return out;
}

/** 某些游戏在家庭里有多份，需要问 Steam「具体谁能借给我」。 */
export async function readLenders(appid: number): Promise<{ accountId: number; preferred: boolean }[] | null> {
  try {
    const r = await steam.SteamClient.FamilySharing.GetAvailableLenders(appid);
    if (!Array.isArray(r)) return null;
    return r.map((x: any) => ({
      accountId: Number(BigInt(x.steamid) - ACCOUNT_BASE),
      preferred: !!x.bPreferred,
    }));
  } catch (e) {
    return null;
  }
}

/** 组装成 core 期望的快照结构（与免安装原型的 snapshot.expr.js 输出保持一致）。 */
function buildSnapshot() {
  const appMap = readApps();
  let familyAppCount = 0;
  for (const v of appMap.values()) {
    if (v.owner !== 0) familyAppCount++;
  }
  return {
    ts: Date.now(),
    me: readMe(),
    members: readMembers(),
    // 成员计数不能在这里按 owner 预聚合：多份游戏必须以 GetAvailableLenders 的实际持有者为准。
    apps: [...appMap.entries()].map(([id, v]) => [id, v.owner, v.copies, v.canonicalType, v.isFree, v.excludedFromSharing]),
    nativeCollections: [],
    appCount: appMap.size,
    familyAppCount,
  };
}

// ---------------------------------------------------------------- 界面挂载

let ui: any = null;
let uiDoc: Document | null = null;
let lenderGeneration = 0;
let mountTimer: ReturnType<typeof setInterval> | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;

/** 确保界面挂到当前的主窗口上；主窗口被关掉重开会自动重建。 */
function installUi(): boolean {
  const doc = findMainDocument();
  if (!doc) return false;
  if (ui?.disposed) {
    lenderGeneration++;
    ui = null;
    uiDoc = null;
  }
  if (ui && uiDoc !== doc) {
    lenderGeneration++;
    try {
      ui.dispose();
    } catch (e) {
      /* 旧 document 可能已经作废 */
    }
    ui = null;
    uiDoc = null;
  }
  if (!ui) {
    const existing = (doc.defaultView as any)?.[NS];
    if (existing && !existing.disposed) {
      try {
        existing.dispose();
      } catch (e) {
        /* 旧版免安装实例可能已失效 */
      }
    }
    ui = createFamilyLensUi({
      doc,
      win: doc.defaultView,
      nativeFilterStore: steam.uiStore,
      // 库主页「所有游戏」陈列架实际绑定 type-games，和 allGamesCollection 不是同一个对象。
      getNativeHomeCollection: () => steam.collectionStore?.GetCollection?.('type-games'),
      requestFreeStatus: async (appid: number): Promise<{ isFree: boolean | null; excludedFromSharing: boolean | null }> => {
        const cached = steam.appDetailsStore?.m_mapAppData?.get?.(appid)?.details;
        const details = cached && typeof cached.bIsFreeApp === 'boolean' && typeof cached.bIsExcludedFromSharing === 'boolean'
          ? cached
          : await steam.appDetailsStore?.RequestAppDetails?.(appid);
        return {
          isFree: typeof details?.bIsFreeApp === 'boolean' ? details.bIsFreeApp : null,
          excludedFromSharing: typeof details?.bIsExcludedFromSharing === 'boolean' ? details.bIsExcludedFromSharing : null,
        };
      },
      meta: { namespace: NS },
    });
    uiDoc = doc;
    (doc.defaultView as any)[NS] = ui;
    ui.setData(buildSnapshot());
    void loadLenders(ui, ++lenderGeneration);
  } else if ((ui.data?.apps?.length || 0) === 0) {
    // Millennium 热重载时 appStore 偶尔比插件入口晚就绪；不要让空快照占满整个 20 秒刷新周期。
    const snapshot = buildSnapshot();
    if (snapshot.apps.length) ui.setData(snapshot);
  }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 分批查询「哪些成员持有该游戏」，结果直接推给 core（core 内部是合并写入）。 */
async function queryLendersWithRetry(appid: number): Promise<{ accountId: number; preferred: boolean }[] | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        readLenders(appid),
        new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 8000); }),
      ]);
      if (result !== null) return result;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (attempt < 2) await sleep(300 * 2 ** attempt);
  }
  console.warn(`[family-lens] 持有者查询失败：${appid}`);
  return null;
}

async function loadLenders(targetUi: any, generation: number): Promise<void> {
  const ids = [...readApps().entries()].filter(([, v]) => v.copies > 1).map(([id]) => id);
  const BATCH = 24;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const pairs = await Promise.all(batch.map(async (id) => [id, await queryLendersWithRetry(id)] as const));
    if (ui !== targetUi || generation !== lenderGeneration || targetUi.disposed) return;
    const map: Record<number, unknown> = {};
    for (const [id, lenders] of pairs) map[id] = lenders;
    targetUi.setLenders(map);
    await sleep(120);
  }
}

let started = false;
function start(): void {
  if (started) return;
  started = true;
  const installed = installUi();
  console.log(`[family-lens] 初始化：主窗口 document ${installed ? '已找到' : '未找到'}；成员 ${readMembers().length} 人；应用 ${readApps().size} 个`);
  mountTimer = setInterval(installUi, 3000);
  snapshotTimer = setInterval(() => {
    if (ui) ui.setData(buildSnapshot());
  }, 20000);
}

function dispose(): void {
  lenderGeneration++;
  if (mountTimer) clearInterval(mountTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  mountTimer = null;
  snapshotTimer = null;
  if (ui) {
    try {
      ui.dispose();
    } catch (e) {
      /* 忽略 */
    }
    ui = null;
    uiDoc = null;
  }
  started = false;
}

// ---------------------------------------------------------------- 设置面板

const Status = () => {
  const [state, setState] = useState<{
    doc: boolean;
    members: number;
    apps: number;
    multi: number;
    uiVersion: number | null;
  } | null>(null);

  useEffect(() => {
    const refresh = () => {
      let multi = 0;
      const apps = readApps();
      apps.forEach((v) => {
        if (v.copies > 1) multi++;
      });
      setState({
        doc: !!findMainDocument(),
        members: readMembers().length,
        apps: apps.size,
        multi,
        uiVersion: ui ? ui.version : null,
      });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, []);

  const line = (label: string, value: string, warn = false) => (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: '20px' }}>
      <span style={{ opacity: 0.65, minWidth: 108 }}>{label}</span>
      <span style={warn ? { color: '#e2a03f' } : undefined}>{value}</span>
    </div>
  );

  return (
    <div style={{ padding: '4px 0' }}>
      {line('主窗口', state ? (state.doc ? '已找到' : '未找到（Steam 库还没打开？）') : '检测中…', state ? !state.doc : false)}
      {line('界面核心', state?.uiVersion ? `已挂载（v${state.uiVersion}）` : '未挂载', !state?.uiVersion)}
      {line('家庭成员', state ? `${state.members} 人` : '—')}
      {line('库中应用', state ? `${state.apps} 个` : '—')}
      {line('家庭内多份', state ? `${state.multi} 个` : '—')}
    </div>
  );
};

export default definePlugin(() => {
  start();
  return {
    title: 'Steam 家庭库透视',
    content: <Status />,
    onDismount: dispose,
  };
});
