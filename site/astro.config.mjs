import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// 요청이 올 때 Cloudflare에서 화면을 만든다 (데이터는 Supabase 공개 버킷에서, 배포 없이 최신)
export default defineConfig({
  output: 'server',
  adapter: cloudflare({ platformProxy: { enabled: false } }),
});
