// 硬删除的外部系统清理：github 目录 + R2 prod/preview 键
// D1 侧清理（表/ACL/PR/注册行）在 Task 7 的 DELETE 路由，避免双写
import type { AppletRemover } from './routes/admin/applets';
import type { GitHubClient } from './github';
import { getGithubClient } from './github-bind';

export type RemoverEnv = {
  DB: D1Database;
  ASSETS: R2Bucket;
  GITHUB: GitHubClient;
};

export function createAppletRemover(env: RemoverEnv): AppletRemover {
  return {
    async remove(slug: string): Promise<void> {
      const gh = getGithubClient(env.GITHUB);
      // main 上删目录（applet 一经删除不应在 main 残留）；无目录视为已删
      try {
        await gh.deleteDir('main', `applets/${slug}/`, `remove applet ${slug} (platform)`, {
          name: 'platform[bot]',
          email: 'platform@noreply.applet-platform',
        });
      } catch (e) {
        if (!(e instanceof Error) || !/not found/i.test(e.message)) throw e;
      }
      // R2: prod + preview 全部键
      for (const prefix of [`prod/${slug}/`, `preview/${slug}/`]) {
        const list = await env.ASSETS.list({ prefix });
        for (const obj of list.objects) {
          await env.ASSETS.delete(obj.key);
        }
      }
    },
  };
}
