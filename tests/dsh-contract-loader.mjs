/**
 * Load the browser client plugin under `node --test` without a DOM.
 *
 * Type-stripping does not accept `.tsx`, and the published primitives
 * package imports its CSS (and a browser-only highlight stack) as runtime
 * dependencies that are not installed here. This hook transpiles our `.tsx`
 * entries, substitutes an empty CSS module, and satisfies the icon import
 * the library names. The icon *exports* themselves are checked against the
 * published primitives bundle in the contract test, not against this stub.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JsxEmit, ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const EMPTY_CSS = new URL('./dsh-contract-empty.mjs', import.meta.url).href
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
const TSX_SUFFIX = '.dsh-tsx.mjs'

/** Named icon imports the client library asks the primitives package for. */
function primitiveIconNames() {
  const source = readFileSync(new URL('../src/client/Library.tsx', import.meta.url), 'utf8')
  const match = source.match(/import\s*\{([^}]*)\}\s*from\s*['"]@deepseek-ai\/dsh-client-ui-primitives['"]/)
  if (match === null) throw new Error('client library no longer imports dsh-client-ui-primitives')
  return match[1].split(',').map(name => name.trim()).filter(name => name !== '')
}

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: { parentURL?: string }) => Promise<{ url: string }>} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) return { url: EMPTY_CSS, shortCircuit: true }
  if (specifier === PRIMITIVES && context.parentURL?.includes('/src/client/')) {
    const source = primitiveIconNames().map(name => `export function ${name}() { return null }\n`).join('')
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  }
  if (specifier.endsWith('.tsx')) {
    const resolved = await nextResolve(specifier, context)
    return { url: `${resolved.url}${TSX_SUFFIX}`, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

/**
 * @param {string} url
 * @param {object} context
 * @param {(url: string, context: object) => Promise<{ source: string, format: string }>} nextLoad
 */
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith(TSX_SUFFIX)) {
    const tsxUrl = url.slice(0, -TSX_SUFFIX.length)
    const source = readFileSync(fileURLToPath(tsxUrl), 'utf8')
    const transpiled = transpileModule(source, {
      fileName: fileURLToPath(tsxUrl),
      compilerOptions: {
        target: ScriptTarget.ES2022,
        module: ModuleKind.ESNext,
        jsx: JsxEmit.ReactJSX,
      },
    })
    return { format: 'module', source: transpiled.outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}
