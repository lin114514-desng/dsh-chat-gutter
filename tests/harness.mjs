// 测试用加载器：不装 jsdom，用最小的 window/document 桩把浏览器那半边的
// factory 取出来，直接测试其中的纯逻辑。真正的 DOM 行为留给运行中的页面验收。
// 用 new Function 而不是 vm：让返回的数组/对象留在当前 realm，断言才能按值比较。
import { readFileSync } from 'node:fs'
import { FakeDocument, makeWindowStub } from './fake-dom.mjs'

if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
}
if (typeof globalThis.cancelAnimationFrame !== 'function') {
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle)
}
if (typeof globalThis.MutationObserver !== 'function') {
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() { return [] }
  }
}

function makeStubDocument() {
  return {
    head: { appendChild() {} },
    body: { appendChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({
      style: {},
      dataset: {},
      setAttribute() {},
      getAttribute: () => null,
      appendChild() {},
      remove() {},
      textContent: '',
      className: '',
      classList: { add() {}, remove() {}, toggle() {} },
    }),
    addEventListener() {},
    removeEventListener() {},
    documentElement: null,
  }
}

export function loadClient(options = {}) {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let definition
  const windowStub = options.window ?? makeWindowStub()
  const documentStub = options.document ?? makeStubDocument()
  windowStub.__ModuleLoader__ = { load(value) { definition = value } }
  const run = new Function('window', 'document', 'console', code)
  run(windowStub, documentStub, console)

  if (definition === undefined) throw new Error('client bundle never called window.__ModuleLoader__.load')
  if (definition.id !== 'dsh-chat-gutter') throw new Error('unexpected module id: ' + definition.id)

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    memo: (component) => component,
  }
  const exports = definition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  })
  return { definition, exports, window: windowStub, document: documentStub }
}

export { FakeDocument, makeWindowStub }
