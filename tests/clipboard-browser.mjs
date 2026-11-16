/** Usage: pnpm build && node tests/clipboard-browser.mjs [en|zh]; open the printed file URL. Synthetic UI fixture, no host boot. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTestDirectory } from './temp-dir.mjs'
import { en, zh } from '../lib/client/locales.js'

const locale = process.argv[2] ?? 'en'
if (!['en', 'zh'].includes(locale)) throw new Error('expected fixture locale en or zh')

const require = createRequire(import.meta.url)
const project = dirname(dirname(require.resolve('./clipboard-browser.mjs')))
const reactRoot = dirname(require.resolve('react/package.json'))
const domRoot = dirname(require.resolve('react-dom/package.json'))
const scripts = [
  readFileSync(join(reactRoot, 'umd/react.development.js'), 'utf8'),
  readFileSync(join(domRoot, 'umd/react-dom.development.js'), 'utf8'),
]
const bundle = readFileSync(join(project, 'lib/client.js'), 'utf8')
const dir = createTestDirectory('clipboard-browser-')
const target = join(dir, 'index.html')
const harness = String.raw`
  window.fixture = { mode: 'missing', copies: [], originalPayload: null, writes: 0, pending: [], nativeWrites: 0, legacyCalls: 0 };
  const originalClipboard = navigator.clipboard;
  const text = '合成提示词：line 1\nline 2 {{date}}';
  const rows = [{ id: 'safe-one', name: 'Synthetic example', content: text, scope: 'global', session_id: null,
    description: null, position: 0, category: 'Synthetic category', inject_enabled: false, inject_every: null,
    mode: 'inject', created_at: '2026-01-01', updated_at: '2026-01-01' }];
  const originalExec = document.execCommand?.bind(document);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, get() {
    if (fixture.mode === 'missing' || fixture.mode === 'legacy') return undefined;
    return { writeText: async value => {
      fixture.originalPayload = value;
      if (fixture.mode === 'success') { fixture.copies.push(value); return; }
      if (fixture.mode === 'native') {
        if (!originalClipboard?.writeText) throw new DOMException('native API absent', 'NotSupportedError');
        await originalClipboard.writeText(value);
        fixture.nativeWrites += 1;
        return;
      }
      if (fixture.mode === 'delayed') return new Promise((resolve, reject) => { fixture.pending.push({ resolve, reject }); });
      throw new DOMException('synthetic browser restriction', fixture.mode === 'security' ? 'SecurityError' : 'NotAllowedError');
    } };
  } });
  document.execCommand = command => {
    if (command !== 'copy') return false;
    fixture.legacyCalls += 1;
    const value = document.activeElement?.value;
    fixture.originalPayload = value;
    if (fixture.mode !== 'legacy') return false;
    // Exercise the actual browser compatibility path, without reading the clipboard.
    return originalExec?.(command) === true;
  };
  const runtime = {
    react: React,
    'react/jsx-runtime': {
      Fragment: React.Fragment,
      jsx: (type, props, key) => React.createElement(type, { ...props, key }),
      jsxs: (type, props, key) => { const { children, ...rest } = props; return React.createElement(type, { ...rest, key }, ...children); },
    },
    '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => React.createElement('span', null, '◇') }),
    '@deepseek-ai/dsh-client-store': { defineStore: () => { throw new Error('fixture must not create a host store') } },
  };
  window.__ModuleLoader__ = { load: ({ factory }) => { window.fixturePlugin = factory(id => {
    if (!(id in runtime)) throw new Error('unexpected fixture dependency: ' + id);
    return runtime[id];
  }); } };
`;
const mount = String.raw`
  const dict = DICTIONARY;
  const mutation = async () => { fixture.writes += 1; throw new Error('read-only fixture mutation'); };
  const props = {
    sessionId: 'synthetic-session', t: key => dict[key] ?? key,
    refresh: async () => rows, refreshCategories: async () => [{ name: 'Synthetic category', scope: 'global', session_id: null }],
    create: mutation, update: mutation, remove: mutation, makeGlobal: mutation, createCategory: mutation, removeCategory: mutation,
    insert() {}, send() {}, interject() {}, injectStatus: async () => null, injectionHistory: async () => [],
    eventPolicies: async () => ({ items: [], enabled: false }), eventEpisodes: async () => [], updateEventPolicy: mutation,
  };
  const root = ReactDOM.createRoot(document.getElementById('root'));
  fixture.switchSession = sessionId => root.render(React.createElement(fixturePlugin.PromptTab, { ...props, sessionId }));
  root.render(React.createElement(fixturePlugin.PromptTab, props));
`.replace('DICTIONARY', JSON.stringify(locale === 'zh' ? zh : en));
const script = value => '<script>' + value.replaceAll('</script', '<\\/script') + '</script>'
const html = '<!doctype html><meta charset="utf-8"><title>Clipboard sharing isolated browser fixture</title>'
  + '<style>body{font:14px sans-serif;background:#fff;color:#222}#root{position:relative;width:420px;height:640px}textarea{color:#222;background:#fff}</style>'
  + '<h1>Synthetic sharing fixture — no DSH host or production data</h1><div id="root"></div>'
  + scripts.map(script).join('') + script(harness) + script(bundle) + script(mount)
writeFileSync(target, html)
console.log(pathToFileURL(target).href)
