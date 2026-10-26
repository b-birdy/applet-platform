// GitHub 客户端注入点：生产走 index.ts 组装（env Secrets），测试可覆盖
import { GitHubClient } from './github';

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

/** 生产路径：测试 override 优先，否则用 Secrets 组装真实客户端；未配置时抛错 */
export function getGithubClientForEnv(env: { GITHUB_TOKEN?: string; GITHUB_OWNER?: string; GITHUB_REPO?: string; GITHUB?: unknown }): GitHubClient {
  if (override) return override; // 测试注入优先
  if ((env as any).GITHUB) return (env as any).GITHUB as GitHubClient;
  if (env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO) {
    return new GitHubClient(env.GITHUB_TOKEN, env.GITHUB_OWNER, env.GITHUB_REPO);
  }
  throw new Error('GitHub not configured (GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO secrets)');
}
