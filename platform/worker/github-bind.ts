// GitHub 客户端注入点：生产走 index.ts 组装（env Secrets），测试可覆盖
import type { GitHubClient } from './github';

let override: GitHubClient | null = null;

/** 测试专用：注入 stub；传 null 恢复默认 */
export function setGithubClient(gh: GitHubClient | null): void {
  override = gh;
}

/** override 优先；两者皆无时抛错（GitHub 未配置） */
export function getGithubClient(fallback?: GitHubClient): GitHubClient {
  if (override) return override;
  if (!fallback) throw new Error('GitHub not configured');
  return fallback;
}
