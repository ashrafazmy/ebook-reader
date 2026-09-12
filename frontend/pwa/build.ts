import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
export function offlineShell(): Plugin {
  return {
    name: 'reader-production-shell', apply: 'build', enforce: 'post',
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter((name) => name === 'index.html' || name.startsWith('assets/'));
      const publicFiles = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
      const template = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
      const hash = createHash('sha256').update(template);
      for (const file of files.sort()) { const item = bundle[file]; hash.update(item.type === 'chunk' ? item.code : item.source); }
      for (const file of publicFiles) hash.update(readFileSync(new URL(`../public/${file}`, import.meta.url)));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: template
        .replace('__READER_CACHE__', `reader-shell-${hash.digest('hex').slice(0, 16)}`)
        .replace('__READER_SHELL__', JSON.stringify([...files, ...publicFiles].map((file) => `/${file}`))) });
    },
  };
}
