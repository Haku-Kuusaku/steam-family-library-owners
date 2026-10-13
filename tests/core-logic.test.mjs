import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/ui/core.js', import.meta.url), 'utf8');

test('持有者界面不重复显示 Steam 原生首选标记', () => {
  assert.doesNotMatch(source, /首选|fl-pref/);
});

const { familyLensAllowedIds, familyLensMergeHomeIds, familyLensKeepCards,
  familyLensNormalizePreferences, familyLensPanelGeometry, familyLensTooltipGeometry } = runInNewContext(
  `${source}\n({ familyLensAllowedIds, familyLensMergeHomeIds, familyLensKeepCards, familyLensNormalizePreferences, familyLensPanelGeometry, familyLensTooltipGeometry })`,
);

test('成员头像提示框跟随按钮且不越过窗口右侧', () => {
  const viewport = { width: 680, height: 450 };
  assert.deepEqual({ ...familyLensTooltipGeometry(
    { left: 630, width: 36, top: 42, bottom: 80 },
    { width: 220, height: 54 }, viewport,
  ) }, { left: 452, top: 88 });
  assert.deepEqual({ ...familyLensTooltipGeometry(
    { left: 10, width: 36, top: 400, bottom: 438 },
    { width: 220, height: 54 }, viewport,
  ) }, { left: 8, top: 338 });
});

test('成员筛选：并集、交集和清除', () => {
  const apps = new Map([[1, {}], [2, {}], [3, {}]]);
  const owners = new Map([[1, [10]], [2, [20]], [3, [10, 20]]]);
  const ownedByIds = (id) => owners.get(id);
  assert.deepEqual([...familyLensAllowedIds(apps, [10, 20], 'union', ownedByIds)], [1, 2, 3]);
  assert.deepEqual([...familyLensAllowedIds(apps, [10, 20], 'intersection', ownedByIds)], [3]);
  assert.deepEqual([...familyLensAllowedIds(apps, [], 'union', ownedByIds)], [1, 2, 3]);
});

test('主页集合更新时保留原本被筛掉的有效游戏，并纳入新游戏', () => {
  const valid = new Map([[1, {}], [2, {}], [3, {}], [4, {}]]);
  const restored = familyLensMergeHomeIds([1, 2, 3, 9], [2, 4], valid);
  assert.deepEqual([...restored], [1, 2, 3, 4]);
});

test('一两张收藏夹游戏卡可识别，但详情配图和左侧小图标不误判', () => {
  const portrait = {
    key: 'portrait',
    img: { src: 'https://steamcdn/assets/123/library_600x900.jpg' },
    rect: { left: 540, width: 190, height: 285 },
  };
  const leftIcon = {
    key: 'icon',
    img: { src: 'https://steamcdn/assets/456/library_600x900.jpg' },
    rect: { left: 20, width: 300, height: 24 },
  };
  assert.deepEqual(familyLensKeepCards([portrait, leftIcon], new Set(), 420, null).map((c) => c.key), ['portrait']);
  assert.deepEqual(familyLensKeepCards([portrait], new Set(), 420, 123).map((c) => c.key), []);
});

test('详情面板随封面滚动时仅被主顶栏裁切，0 对齐封面右上角', () => {
  const viewport = { width: 2048, height: 1104, headerBottom: 94, occlusionBottom: 154 };
  const p = familyLensNormalizePreferences(null);
  const before = familyLensPanelGeometry({ top: 100, bottom: 500, right: 1800 }, viewport, 280, p);
  const after = familyLensPanelGeometry({ top: -100, bottom: 300, right: 1800 }, viewport, 280, p);
  assert.deepEqual({ ...before }, { top: 100, right: 248, clipTop: 0, hidden: false });
  assert.deepEqual({ ...after }, { top: -100, right: 248, clipTop: 194, hidden: false });
  assert.deepEqual({ ...familyLensPanelGeometry({ top: 100, bottom: 500, right: 1800 }, viewport, 280,
    { placement: 'follow', verticalInset: 50 }) },
  { top: 150, right: 248, clipTop: 0, hidden: false });
  assert.equal(familyLensPanelGeometry({ top: -350, bottom: 50, right: 1800 }, viewport, 280, p).hidden, true);
});

test('合并吸附/固定模式并对齐两种显示策略的右上角', () => {
  const viewport = { width: 2048, height: 1104, headerBottom: 94, occlusionBottom: 154 };
  const visible = { top: 180, bottom: 580, right: 1800 };
  const scrolled = { top: -100, bottom: 300, right: 1800 };
  const initiallyVisibleViewport = { ...viewport, occlusionBottom: 94 };
  assert.deepEqual({ ...familyLensPanelGeometry(visible, initiallyVisibleViewport, 280,
    { placement: 'sticky' }) },
  { top: 180, right: 248, clipTop: 0, hidden: false });
  assert.deepEqual({ ...familyLensPanelGeometry(visible, initiallyVisibleViewport, 280,
    { placement: 'follow' }) },
  { top: 180, right: 248, clipTop: 0, hidden: false });
  assert.deepEqual({ ...familyLensPanelGeometry(scrolled, viewport, 280,
    { placement: 'sticky' }) },
  { top: 154, right: 248, clipTop: 0, hidden: false });
  assert.equal(familyLensPanelGeometry(scrolled, viewport, 280,
    { placement: 'sticky', verticalInset: 30 }).top, 184);
  assert.equal(familyLensPanelGeometry(scrolled, viewport, 280,
    { placement: 'sticky', horizontalInset: 30 }).right, 278);
  assert.equal(familyLensPanelGeometry(scrolled, viewport, 280,
    { placement: 'fixed' }).top, 154);
  assert.equal(familyLensPanelGeometry({ top: -350, bottom: 50, right: 1800 }, viewport, 280,
    { placement: 'sticky' }).hidden, false);
  assert.equal(familyLensPanelGeometry(scrolled, viewport, 280, { placement: 'hidden' }).hidden, true);
});

test('非负偏移与旧设置迁移', () => {
  const invalid = familyLensNormalizePreferences({ placement: 'unknown', opacity: 999,
    verticalInset: -40, horizontalInset: 999 });
  assert.deepEqual({ placement: invalid.placement, opacity: invalid.opacity,
    verticalInset: invalid.verticalInset, horizontalInset: invalid.horizontalInset },
  { placement: 'follow', opacity: 100, verticalInset: 0, horizontalInset: 200 });
  assert.deepEqual({ ...familyLensNormalizePreferences({ placement: 'fixed', fixedTopOffset: 50, rightInset: 30 }) },
    { placement: 'sticky', density: 'standard', opacity: 95, verticalInset: 50,
      horizontalInset: 30, showAvatars: true });
  assert.deepEqual({ ...familyLensNormalizePreferences({ placement: 'follow',
    verticalOffset: -46, horizontalOffset: 11 }) },
    { placement: 'follow', density: 'standard', opacity: 95, verticalInset: 10,
      horizontalInset: 7, showAvatars: true });
  assert.equal(familyLensNormalizePreferences({ topOffset: 0 }).verticalInset, 0);
  assert.equal(familyLensNormalizePreferences(null).verticalInset, 0);
  assert.equal(familyLensNormalizePreferences(null).horizontalInset, 0);
});
