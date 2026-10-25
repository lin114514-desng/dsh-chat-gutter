// 流式卡顿契约：扫描只由真正的结构变化驱动。
//   · 覆盖层自己写的 DOM 不能再触发扫描（2026-10-22 实测：全页观察器 + 自身写入 = 永久自激）；
//   · 只有文字在长（流式吐字）时走「只量坐标」的快路，不重建标记；
//   · 一串变动合并成一次结构检查。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'
import { FakeDocument, makeWindowStub, rect } from './fake-dom.mjs'

class FakeMutationObserver {
  static instances = []
  constructor(callback) {
    this.callback = callback
    this.target = null
    this.options = null
    this.active = false
    FakeMutationObserver.instances.push(this)
  }

  observe(target, options) {
    this.target = target
    this.options = options
    this.active = true
  }

  disconnect() {
    this.active = false
  }

  takeRecords() {
    return []
  }

  fire(records) {
    if (!this.active) return
    this.callback(records ?? [], this)
  }
}

globalThis.MutationObserver = FakeMutationObserver

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 结构检查有最小间隔（流式期间把重扫压到 ≤ 6 次/秒），等够一拍的余量。
const FLUSH = 300

function addRow(doc, parent, spec) {
  const element = doc.createElement('div')
  element.setAttribute('data-chat-flow-key', spec.key)
  element.setAttribute('data-chat-node-key', spec.key)
  element.setAttribute('data-chat-flow-kind', spec.kind)
  element.setAttribute('data-chat-turn', spec.turn)
  element.rect = rect(spec.left ?? 300, spec.top, spec.width ?? 600, spec.height)
  element.textContent = spec.text ?? ''
  parent.appendChild(element)
  return element
}

function buildDom() {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 800)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: 100, height: 30, text: '你好' })
  addRow(doc, flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: 150, height: 40, text: '调用工具' })
  const answer1 = addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: 220, height: 80, text: '第一段回答' })
  const think = doc.createElement('div')
  think.setAttribute('data-variant', 'think')
  think.rect = rect(320, 242, 200, 20)
  think.textContent = '思考一下'
  answer1.appendChild(think)
  return { doc, flow, answer1, think }
}

function buildCtx() {
  const snapshot = {
    status: 'ready',
    value: { enabled: true, showNumbers: true, showBadges: true, answerMark: 'tools' },
    revision: 1,
    writable: true,
  }
  const listeners = new Set()
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async () => true,
  }
  const forms = {
    get: (id) => (id === 'dsh-chat-gutter' ? form : undefined),
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-chat-gutter' }] } }), subscribe: () => () => {} }),
    whileServed: (_namespaces, callback) => {
      callback()
      return () => {}
    },
  }
  const ctx = {
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject(_name, callback) {
        callback()
        return () => {}
      },
      register(options) {
        if (String(options.name).startsWith('conversation.input.') && options.id === undefined) {
          throw new Error('list slot "' + options.name + '" requires options.id')
        }
        return () => {}
      },
    },
    inject(_services, callback) {
      callback({ configForms: forms })
      return () => {}
    },
  }
  return { ctx, snapshot, listeners }
}

function setup() {
  const dom = buildDom()
  const windowStub = makeWindowStub()
  FakeMutationObserver.instances = []
  const { exports } = loadClient({ window: windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)
  const bodyObserver = FakeMutationObserver.instances.find((observer) => observer.target === dom.doc.body)
  const flowObserver = FakeMutationObserver.instances.find((observer) => observer.target === dom.flow)
  assert.notEqual(bodyObserver, undefined, '没装 body 观察器')
  assert.notEqual(flowObserver, undefined, '没装 flow 观察器')
  return { dom, windowStub, exports, dispose, bodyObserver, flowObserver }
}

function bandMarkers(doc, id) {
  const overlay = doc.getElementById(id)
  assert.notEqual(overlay, null)
  return overlay.children.filter((child) => String(child.className).startsWith('dcg-marker'))
}

function bandTexts(doc, id) {
  return bandMarkers(doc, id).map((marker) => marker.textContent)
}

function stats(exports) {
  return exports.__test.scanStats()
}

test('覆盖层自己写的 DOM 不再牵着自己重扫（自激断了）', async () => {
  const { dom, exports, bodyObserver } = setup()
  const overlay = dom.doc.getElementById('dsh-chat-gutter')
  assert.notEqual(overlay, null)
  const before = stats(exports)

  bodyObserver.fire([{ type: 'childList', target: overlay, addedNodes: [], removedNodes: [] }])
  bodyObserver.fire([{ type: 'childList', target: overlay, addedNodes: [], removedNodes: [] }])
  await sleep(40)

  const state = exports.__test.stateForTest()
  assert.equal(state.scanTimer, null, '自身写入不该排扫描定时器')
  assert.equal(state.scanRaf, null, '自身写入不该排扫描帧')
  assert.equal(stats(exports).full, before.full, '自身写入不该触发全量重扫')
})

test('聊天流被换掉后，body 观察器重新找到新流并重扫', async () => {
  const { dom, bodyObserver, exports } = setup()
  const oldFlow = dom.flow
  oldFlow.remove()

  const newFlow = dom.doc.createElement('div')
  newFlow.setAttribute('data-slot', 'conversation.chat.flow')
  newFlow.rect = rect(300, 0, 600, 800)
  dom.doc.body.appendChild(newFlow)
  addRow(dom.doc, newFlow, { key: 'v1', turn: '9', kind: 'user', top: 60, height: 30, text: '新会话' })

  bodyObserver.fire([{ type: 'childList', target: dom.doc.body, addedNodes: [newFlow], removedNodes: [oldFlow] }])
  await sleep(FLUSH)

  assert.deepEqual(bandTexts(dom.doc, 'dsh-chat-gutter-right'), ['#9'])
  const rebound = FakeMutationObserver.instances.find((observer) => observer.target === newFlow)
  assert.notEqual(rebound, undefined, '没有把 flow 观察器绑到新聊天流上')
  assert.equal(rebound.active, true)
  assert.equal(exports.__test.stateForTest().flowEl, newFlow)
})

test('流式只改文字：不做全量重扫，但位置照常跟上（快路）', async () => {
  const { dom, exports, flowObserver } = setup()
  const before = stats(exports)
  assert.ok(before.full >= 1, '初次扫描应该已经跑过')

  // 上方内容被撑高：结构没变，只有坐标变了。
  dom.flow.querySelector('[data-chat-flow-key="u1"]').rect.top = 160
  flowObserver.fire([{ type: 'characterData', target: dom.answer1 }])
  await sleep(FLUSH)

  const after = stats(exports)
  assert.equal(after.full, before.full, '文字变化不该重建标记')
  assert.equal(after.cheap, before.cheap + 1, '文字变化应该走一次只量坐标的快路')

  const number = bandMarkers(dom.doc, 'dsh-chat-gutter-right').find((marker) => marker.textContent === '#1')
  assert.notEqual(number, undefined)
  assert.equal(number.style.top, '160px')
})

test('新增工具行：一串变动合并成一次结构检查，徽标跟着变', async () => {
  const { dom, exports, flowObserver } = setup()
  const before = stats(exports)

  addRow(dom.doc, dom.flow, { key: 'tool2', turn: '1', kind: 'tool-call', top: 260, height: 40, text: '再来一次工具' })
  flowObserver.fire([{ type: 'childList', target: dom.flow, addedNodes: [], removedNodes: [] }])
  flowObserver.fire([{ type: 'childList', target: dom.flow, addedNodes: [], removedNodes: [] }])
  flowObserver.fire([{ type: 'childList', target: dom.flow, addedNodes: [], removedNodes: [] }])
  await sleep(FLUSH)

  const after = stats(exports)
  assert.equal(after.full, before.full + 1, '一串变动只该合成一次全量重扫')
  assert.ok(bandTexts(dom.doc, 'dsh-chat-gutter').includes('⚙️2 🧐1'), '徽标没跟上：' + JSON.stringify(bandTexts(dom.doc, 'dsh-chat-gutter')))
})

test('结构不变时连刷多轮也不重复重扫（空闲即静止）', async () => {
  const { dom, exports, bodyObserver, flowObserver } = setup()
  const before = stats(exports)

  for (let round = 0; round < 3; round += 1) {
    bodyObserver.fire([{ type: 'childList', target: dom.doc.getElementById('dsh-chat-gutter'), addedNodes: [], removedNodes: [] }])
    flowObserver.fire([{ type: 'characterData', target: dom.answer1 }])
    await sleep(FLUSH)
  }

  const after = stats(exports)
  assert.equal(after.full, before.full, '结构没变就不该有全量重扫')
  assert.ok(after.cheap >= before.cheap + 3, '文字变化仍要刷新几何: ' + JSON.stringify(after))
})

test('滚动时徽标与编号每帧跟手，不钉在视口上', async () => {
  const { dom, windowStub, exports } = setup()
  const before = stats(exports)

  const number = bandMarkers(dom.doc, 'dsh-chat-gutter-right').find((marker) => marker.textContent === '#1')
  const badge = bandMarkers(dom.doc, 'dsh-chat-gutter').find((marker) => String(marker.textContent).startsWith('⚙️'))
  assert.notEqual(number, undefined)
  assert.notEqual(badge, undefined)
  const numberTop = Number(String(number.style.top).replace('px', ''))
  const badgeTop = Number(String(badge.style.top).replace('px', ''))

  // 向上滚 200px：所有行的视口坐标 +200。覆盖层是 position:fixed，必须跟着重算。
  for (const row of dom.flow.querySelectorAll('[data-chat-flow-key]')) row.rect.top += 200
  windowStub.dispatch('scroll')
  await sleep(40)

  assert.equal(Number(String(number.style.top).replace('px', '')), numberTop + 200, '编号没跟着滚动重算')
  assert.equal(Number(String(badge.style.top).replace('px', '')), badgeTop + 200, '徽标没跟着滚动重算')

  // 滚动照样一次扫描都不排。
  const after = stats(exports)
  assert.equal(after.full, before.full)
  assert.equal(after.cheap, before.cheap)
  assert.equal(exports.__test.stateForTest().scanTimer, null)
})

