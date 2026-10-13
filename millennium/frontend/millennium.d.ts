/**
 * Millennium 运行时模块（`millennium`）由插件加载器注入，npm 上没有它的类型定义，
 * 这里按实际用到的 API 手工声明，让 `tsc --noEmit` 能过。
 * 参考官方模板：https://github.com/SteamClientHomebrew/PluginTemplate
 */
declare module 'millennium' {
  import type { ReactNode } from 'react';

  export type PluginSettings = {
    title?: string;
    icon?: ReactNode;
    content?: ReactNode;
    onDismount?: () => void;
  };

  /** 注册插件：回调里做初始化，返回值是插件在设置里的信息与设置面板内容。 */
  export function definePlugin(factory: () => PluginSettings): unknown;

  export function Field(props: { label?: ReactNode; children?: ReactNode; [key: string]: unknown }): ReactNode;
  export function Toggle(props: Record<string, unknown>): ReactNode;
  export function ToggleField(props: Record<string, unknown>): ReactNode;
  export function Dropdown(props: Record<string, unknown>): ReactNode;
  export function Button(props: Record<string, unknown>): ReactNode;

  /** 由 millennium.toml 的 [backend] 暴露给前端的 RPC 调用。 */
  export const backend: Record<string, (...args: unknown[]) => Promise<unknown>>;
}
