// wrangler.toml 绑定（DB/ASSETS）的类型映射，供 cloudflare:test env 使用
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: R2Bucket;
    ASSET_FILES?: Fetcher;
  }
}
