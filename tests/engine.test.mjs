// 用最小 DOM 桩跑一遍真实扫描路径：覆盖层、编号、徽标、高亮、配置开关。
// 目的不是替代页面验收，而是把「代码根本没跑起来」这类错误挡在安装之前。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'
import { FakeDocument, makeWindowStub, rect } from './fake-dom.mjs'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function addRow(doc, parent, spec) {
  const element = doc.createElement('div')
  element.setAttribute('data-chat-flow-key', spec.key)
  element.setAttribute('data-chat-node-key', spec.key)
  element.setAttribute('data-chat-flow-kind', spec.kind)
  if (spec.turn !== undefined) element.setAttribute('data-chat-turn', spec.turn)
  if (spec.groupPart !== undefined) element.setAttribute('data-chat-group-part', spec.groupPart)
  if (spec.hidden === true) element.setAttribute('hidden', '')
  element.rect = rect(spec.left ?? 300, spec.top, spec.width ?? 600, spec.height)
  element.textContent = spec.text ?? ''
  parent.appendChild(element)
  if (spec.questionReply === true) {
    const reply = doc.createElement('span')
    reply.setAttribute('data-question-reply', 'call-1')
    reply.rect = rect(320, spec.top, 100, 20)
    reply.textContent = '已回答'
    element.appendChild(reply)
  }
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
  const answer2 = addRow(doc, flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: 320, height: 60, text: '后续回答' })
  const think = doc.createElement('div')
  think.setAttribute('data-variant', 'think')
  think.rect = rect(320, 342, 200, 20)
  think.textContent = '思考一下'
  answer2.appendChild(think)

  addRow(doc, flow, { key: 'u2', turn: '2', kind: 'user', top: 420, height: 30, text: '再来' })
  addRow(doc, flow, { key: 'cmd1', turn: '2', kind: 'command', top: 470, height: 40, text: '执行命令' })
  const answer3 = addRow(doc, flow, { key: 'a3', turn: '2', kind: 'assistant-step', top: 530, height: 60, text: '第二回合回答' })

  const question = doc.createElement('div')
  question.setAttribute('data-question-key', 'q-1')
  question.rect = rect(300, 600, 600, 200)
  question.textContent = '请选择'
  doc.body.appendChild(question)

  return { doc, flow, answer1, answer3, think, question }
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
    describe: () => ({
      getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-chat-gutter' }] } }),
      subscribe: () => () => {},
    }),
    whileServed: (_namespaces, callback) => {
      callback()
      return () => {}
    },
  }
  const registrations = []
  const injects = []
  const ctx = {
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject(name, callback) {
        injects.push(name)
        callback()
        return () => {}
      },
      register(options, component) {
        // 真机契约：list 型插槽（conversation.input.* 等）注册必须带 id，
        // 缺了会在插件导入时抛错连坐同批插件（2026-10-22 实录）。
        if (String(options.name).startsWith('conversation.input.') && options.id === undefined) {
          throw new Error('list slot "' + options.name + '" requires options.id')
        }
        registrations.push({ options, component })
        return () => {}
      },
    },
    inject(services, callback) {
      injects.push(services.join(','))
      callback({ configForms: forms })
      return () => {}
    },
  }
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return { ctx, snapshot, notify, registrations, injects, listenerCount: () => listeners.size }
}

function markersOf(doc) {
  const overlay = doc.getElementById('dsh-chat-gutter')
  assert.notEqual(overlay, null)
  return overlay.children.filter((child) => String(child.className).startsWith('dcg-marker'))
}

function bandMarkers(doc, id) {
  const overlay = doc.getElementById(id)
  assert.notEqual(overlay, null)
  return overlay.children.filter((child) => String(child.className).startsWith('dcg-marker'))
}

function bandTexts(doc, id) {
  return bandMarkers(doc, id).map((marker) => marker.textContent)
}

test('真实扫描：编号/徽标/回答高亮/提问卡/思考块都出现在覆盖层里', async () => {
  const dom = buildDom()
  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: dom.doc })
  const harness = buildCtx()
  const dispose = exports.apply(harness.ctx)

  assert.deepEqual(harness.registrations.map((item) => item.options.key), ['dsh-chat-gutter#dsh-chat-gutter', 'dsh-chat-gutter#quick-nav'])
  assert.deepEqual(harness.injects, ['plugins.row.config', 'conversation.input.left', 'configForms'])

  const overlay = dom.doc.getElementById('dsh-chat-gutter')
  assert.notEqual(overlay, null)
  assert.equal(overlay.style.display, 'block')
  assert.equal(overlay.style.transform, 'translateX(200px)')

  // 编号单独一条带，贴在内容列右侧空白处：内容 300–900，带子从 908 起。
  const rightOverlay = dom.doc.getElementById('dsh-chat-gutter-right')
  assert.notEqual(rightOverlay, null)
  assert.equal(rightOverlay.style.display, 'block')
  assert.equal(rightOverlay.style.transform, 'translateX(908px)')
  assert.deepEqual(bandTexts(dom.doc, 'dsh-chat-gutter-right').sort(), ['#1', '#2'])

  const texts = bandTexts(dom.doc, 'dsh-chat-gutter')
  assert.ok(!texts.includes('#1'))
  assert.ok(texts.includes('⚙️1 🧐1'))
  assert.ok(texts.includes('⌨️1'))
  assert.ok(texts.includes('🤔提问'))
  assert.equal(texts.filter((text) => text === '▶答').length, 2)

  assert.equal(dom.answer1.getAttribute('data-dsh-answer-start'), '1')
  assert.equal(dom.answer3.getAttribute('data-dsh-answer-start'), '1')

  const numberMarker = bandMarkers(dom.doc, 'dsh-chat-gutter-right').find((marker) => marker.textContent === '#1')
  assert.equal(numberMarker.style.top, '100px')
  const rail = overlay.children.find((child) => child.className === 'dcg-rail')
  assert.notEqual(rail, undefined)
  assert.equal(rail.style.display, 'block')

  dispose()
  assert.equal(dom.doc.getElementById('dsh-chat-gutter'), null)
  assert.equal(dom.answer1.getAttribute('data-dsh-answer-start'), null)
})

test('提问行在左带留下 🤔 标记：答过的提问没有提问卡，也要有标记', async () => {
  const dom = buildDom()
  // 答过的提问在历史里只剩过程组那一行，提问卡已经撤掉。
  const seat = dom.doc.createElement('div')
  seat.setAttribute('data-chat-flow-key', 'q-seat')
  seat.setAttribute('data-chat-turn', '2')
  seat.setAttribute('data-step-process', 'true')
  seat.rect = rect(300, 640, 600, 26)
  const header = dom.doc.createElement('div')
  header.rect = rect(300, 640, 600, 26)
  header.textContent = '向用户提出了问题 提问2/2 已回答'
  seat.appendChild(header)
  const body = dom.doc.createElement('div')
  body.setAttribute('data-step-process-body', '')
  seat.appendChild(body)
  dom.flow.appendChild(seat)

  const { exports } = loadClient({ window: makeWindowStub(), document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  const texts = bandTexts(dom.doc, 'dsh-chat-gutter')
  assert.equal(texts.filter((text) => text === '🤔').length, 1)

  dispose()
})

test('提问按组头分类：组内容里提到 ask_user_question 的工具组不算提问，也不挂 🤔', async () => {
  const dom = buildDom()
  // 工具组的组头是「已完成分析」，但组里的思考文本提到了 ask_user_question。
  const seat = dom.doc.createElement('div')
  seat.setAttribute('data-chat-flow-key', 'tool-seat')
  seat.setAttribute('data-chat-turn', '2')
  seat.setAttribute('data-step-process', 'true')
  seat.rect = rect(300, 660, 600, 26)
  const header = dom.doc.createElement('div')
  header.rect = rect(300, 660, 600, 26)
  header.textContent = '已完成分析'
  seat.appendChild(header)
  const body = dom.doc.createElement('div')
  body.setAttribute('data-step-process-body', '')
  const row = dom.doc.createElement('div')
  row.textContent = '思考 用 ask_user_question 问一下用户'
  body.appendChild(row)
  seat.appendChild(body)
  dom.flow.appendChild(seat)

  const { exports } = loadClient({ window: makeWindowStub(), document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  const texts = bandTexts(dom.doc, 'dsh-chat-gutter')
  assert.equal(texts.filter((text) => text === '🤔').length, 0)

  const entries = exports.__test.collectPanelEntries(dom.flow)
  const seats = entries.filter((entry) => entry.el === seat)
  assert.equal(seats.length, 1)
  assert.equal(seats[0].type, 'tool')

  dispose()
})

test('配置开关：关总开关立刻清空，重新打开立刻恢复；窄窗口隐藏整条带', async () => {
  const dom = buildDom()
  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: dom.doc })
  const harness = buildCtx()
  const dispose = exports.apply(harness.ctx)
  assert.equal(harness.listenerCount(), 1)
  assert.notEqual(dom.doc.getElementById('dsh-chat-gutter'), null)

  harness.snapshot.value = { ...harness.snapshot.value, enabled: false }
  harness.snapshot.revision = 2
  harness.notify()
  assert.equal(dom.doc.getElementById('dsh-chat-gutter'), null)
  assert.equal(dom.answer1.getAttribute('data-dsh-answer-start'), null)

  harness.snapshot.value = { ...harness.snapshot.value, enabled: true }
  harness.snapshot.revision = 3
  harness.notify()
  assert.notEqual(dom.doc.getElementById('dsh-chat-gutter'), null)
  assert.equal(dom.answer1.getAttribute('data-dsh-answer-start'), '1')

  dom.flow.rect = rect(50, 0, 600, 800)
  windowStub.dispatch('resize')
  await sleep(30)
  assert.equal(dom.doc.getElementById('dsh-chat-gutter').style.display, 'none')

  dom.flow.rect = rect(300, 0, 600, 800)
  windowStub.dispatch('resize')
  await sleep(30)
  assert.equal(dom.doc.getElementById('dsh-chat-gutter').style.display, 'block')

  dispose()
})

test('容器自身没有盒子（display:contents）时，用父列与真实聊天行定位标识带', async () => {
  const doc = new FakeDocument()
  const column = doc.createElement('div')
  column.rect = rect(501, 0, 1042, 900)
  doc.body.appendChild(column)

  // 真实页面里 [data-slot="conversation.chat.flow"] 是 display:contents：
  // 自身不生成盒子，getBoundingClientRect() 恒为 0×0。
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(0, 0, 0, 0)
  column.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', left: 501, width: 1042, top: 60, height: 40, text: '你好' })
  addRow(doc, flow, { key: 'tool1', turn: '1', kind: 'tool-call', left: 525, width: 1018, top: 140, height: 40, text: '调用工具' })
  const answer = addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', left: 501, width: 1042, top: 220, height: 200, text: '第一段回答' })

  const windowStub = makeWindowStub()
  windowStub.innerWidth = 1770
  const { exports } = loadClient({ window: windowStub, document: doc })
  const harness = buildCtx()
  const dispose = exports.apply(harness.ctx)

  const overlay = doc.getElementById('dsh-chat-gutter')
  assert.notEqual(overlay, null)
  assert.equal(overlay.style.display, 'block')
  assert.equal(overlay.style.transform, 'translateX(401px)')

  // 真实聊天行右边缘 501+1042=1543，编号带从 1551 起。
  assert.equal(doc.getElementById('dsh-chat-gutter-right').style.transform, 'translateX(1551px)')
  assert.deepEqual(bandTexts(doc, 'dsh-chat-gutter-right'), ['#1'])
  assert.ok(bandTexts(doc, 'dsh-chat-gutter').includes('⚙️1'))
  assert.equal(answer.getAttribute('data-dsh-answer-start'), '1')

  // 父列也量不出来时，退到真实聊天行自己的左边缘（仍应是 501）。
  column.rect = rect(0, 0, 0, 0)
  windowStub.dispatch('resize')
  await sleep(30)
  assert.equal(doc.getElementById('dsh-chat-gutter').style.transform, 'translateX(401px)')

  dispose()
})

test('编号只锚定用户自己发的那条消息，回合第一行是别的类型也不跟错', async () => {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 800)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'trigger1', turn: '1', kind: 'turn-trigger', top: 100, height: 20, text: '' })
  const mine = addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: 140, height: 30, text: '我的问题' })
  addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: 200, height: 60, text: '回答' })

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const number = bandMarkers(doc, 'dsh-chat-gutter-right').find((marker) => marker.textContent === '#1')
  assert.notEqual(number, undefined)
  assert.equal(number.style.top, mine.rect.top + 'px')

  dispose()
})

test('窗口右侧放不下编号带时整条隐藏，左侧徽标照常显示', async () => {
  const dom = buildDom()
  const windowStub = makeWindowStub()
  windowStub.innerWidth = 700
  const { exports } = loadClient({ window: windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  assert.equal(dom.doc.getElementById('dsh-chat-gutter').style.display, 'block')
  assert.equal(dom.doc.getElementById('dsh-chat-gutter-right').style.display, 'none')

  dispose()
})

test('过程徽标合并：一个回合只出 ⚙️N 🤔N 一个徽标，不再逐行刷屏', async () => {
  const dom = buildDom()
  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  const texts = bandTexts(dom.doc, 'dsh-chat-gutter')
  // buildDom 里 turn1 有 1 个 tool-call + 1 个 think 块，turn2 有 1 个 command。
  assert.equal(texts.filter((text) => text === '⚙️工具').length, 0)
  // buildDom：turn1 = 1 工具 + 1 思考 → ⚙️1 🧐1；turn2 = 1 命令 → ⌨️1。
  assert.equal(texts.filter((text) => text.startsWith('⚙️')).length, 1)
  assert.ok(texts.includes('⚙️1 🧐1'))
  assert.ok(texts.includes('⌨️1'))
  // 回答起点与提问卡不受合并影响。
  assert.ok(texts.includes('▶答'))
  assert.ok(texts.includes('🤔提问'))
  assert.equal(dom.answer1.getAttribute('data-dsh-answer-start'), '1')

  dispose()
})

// 「快速移动」面板夹具：一问一答、一条工具小结、一条提问小结。
// 小结行用官方真机属性 data-step-process；组里塞一条折叠（hidden）的工具行，
// 用来验证「组已经代表过的行不再重复列」。
function buildPanelDom(options = {}) {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 800)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: 100, height: 30, text: '你好' })

  const seatTool = doc.createElement('div')
  seatTool.setAttribute('data-chat-flow-key', 'g1')
  seatTool.setAttribute('data-chat-turn', '1')
  seatTool.setAttribute('data-step-process', 'true')
  seatTool.rect = rect(300, 150, 600, 26)
  seatTool.textContent = '已调用工具 ops_bash · 列目录'
  flow.appendChild(seatTool)
  addRow(doc, seatTool, { key: 'tool1', turn: '1', kind: 'tool-call', top: 150, height: 26, text: 'ops_bash', hidden: true })

  addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: 220, height: 80, text: '第一段回答' })
  addRow(doc, flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: 320, height: 60, text: '第二段回答' })
  addRow(doc, flow, { key: 'u2', turn: '2', kind: 'user', top: 420, height: 30, text: '再来' })

  if (options.withQuestion !== false) {
    const seatQ = doc.createElement('div')
    seatQ.setAttribute('data-chat-flow-key', 'g2')
    seatQ.setAttribute('data-chat-turn', '2')
    seatQ.setAttribute('data-step-process', 'true')
    seatQ.rect = rect(300, 470, 600, 26)
    seatQ.textContent = '向用户提出了问题 提问1/1 已回答'
    flow.appendChild(seatQ)
  }

  const cmd1 = addRow(doc, flow, { key: 'cmd1', turn: '2', kind: 'command', top: 520, height: 40, text: '执行命令' })

  return { doc, flow, cmd1 }
}

async function openPanelIn(dom) {
  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)
  // 插槽名与 dsh-prompt 的入口按钮一致（真机渲染走 React ref → mountNav）。
  exports.__test.mountNav(dom.doc.body)
  const nav = dom.doc.getElementById('dsh-chat-gutter-nav')
  assert.notEqual(nav, null)
  const button = nav.querySelector('[data-dsh-gutter-nav-btn]')
  // 面板挂在 body 下（输入区祖先一有 transform/filter/contain，fixed 就会改认祖先做参照），
  // 不再挂在按钮旁边那层插槽里。
  const panel = dom.doc.querySelector('[data-dcg-panel]')
  assert.notEqual(button, null)
  assert.notEqual(panel, null)
  return { dom, exports, dispose, nav, button, panel }
}

test('快速移动面板：点按钮弹出两列，左列四类带条数，空类别置灰', async () => {
  const dom = buildPanelDom()
  const ui = await openPanelIn(dom)

  assert.equal(ui.panel.style.display, 'none')
  ui.button.dispatchEvent({ type: 'click' })
  assert.equal(ui.panel.style.display, 'flex')

  const cats = ui.panel.querySelectorAll('[data-dcg-cat]')
  assert.deepEqual(cats.map((item) => item.getAttribute('data-dcg-cat')), ['question', 'tool', 'answer', 'ask'])
  // 提问 1（提问小结行）、工具 2（小结行 + 命令行）、回答 1 段（两条连续正文合并）、你的消息 2 条。
  assert.deepEqual(cats.map((item) => item.getAttribute('data-count')), ['1', '2', '1', '2'])
  assert.deepEqual(cats.map((item) => item.getAttribute('data-empty')), ['0', '0', '0', '0'])

  ui.dispose()
})

test('快速移动面板：点左列换右列，编号从 1 起带摘要，点编号滚到那一处并收起面板', async () => {
  const dom = buildPanelDom()
  const ui = await openPanelIn(dom)
  ui.button.dispatchEvent({ type: 'click' })

  const cats = ui.panel.querySelectorAll('[data-dcg-cat]')
  const toolCat = cats.find((item) => item.getAttribute('data-dcg-cat') === 'tool')
  toolCat.dispatchEvent({ type: 'click' })

  const list = ui.panel.querySelector('[data-dcg-list]')
  assert.equal(list.getAttribute('data-dcg-list'), 'tool')
  const entries = list.querySelectorAll('[data-dcg-entry]')
  assert.equal(entries.length, 2)
  assert.match(entries[0].textContent, /^1 · 已调用工具/)
  assert.match(entries[1].textContent, /^2 · 执行命令/)

  // 没有真滚动容器时退回 scrollIntoView，且只跳第 2 条（命令行）。
  entries[1].dispatchEvent({ type: 'click' })
  assert.notEqual(dom.cmd1.lastScrollIntoView, undefined)
  assert.equal(ui.panel.style.display, 'none')

  ui.dispose()
})

test('快速移动面板：空类别点开写「这一类还没有」', async () => {
  const dom = buildPanelDom({ withQuestion: false })
  const ui = await openPanelIn(dom)
  ui.button.dispatchEvent({ type: 'click' })

  const cats = ui.panel.querySelectorAll('[data-dcg-cat]')
  const questionCat = cats.find((item) => item.getAttribute('data-dcg-cat') === 'question')
  assert.equal(questionCat.getAttribute('data-empty'), '1')

  questionCat.dispatchEvent({ type: 'click' })
  const list = ui.panel.querySelector('[data-dcg-list]')
  assert.equal(list.querySelectorAll('[data-dcg-entry]').length, 0)
  assert.ok(list.textContent.includes('这一类还没有'))

  ui.dispose()
})

test('快速移动面板：再点按钮收起，右键也开面板，旧八条菜单不再出现', async () => {
  const dom = buildPanelDom()
  const ui = await openPanelIn(dom)

  ui.button.dispatchEvent({ type: 'click' })
  assert.equal(ui.panel.style.display, 'flex')
  ui.button.dispatchEvent({ type: 'click' })
  assert.equal(ui.panel.style.display, 'none')

  ui.button.dispatchEvent({ type: 'contextmenu', preventDefault() {} })
  assert.equal(ui.panel.style.display, 'flex')

  assert.equal(ui.nav.querySelectorAll('[data-dsh-gutter-nav-menu]').length, 0)
  assert.equal(ui.nav.querySelectorAll('[data-disabled="1"]').length, 0)

  ui.dispose()
})

test('快速移动面板：有真滚动容器时直接写 scrollTop，不再调 scrollIntoView', async () => {
  const dom = buildRealChain()
  const row = addRow(dom.doc, dom.flow, { key: 'u1', turn: '1', kind: 'user', top: 470, height: 30, text: '这里' })
  dom.scroller.scrollTop = 0
  dom.scroller.scrollHeight = 3000
  dom.scroller.clientHeight = 500

  const { exports } = loadClient({ window: dom.windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)
  exports.__test.mountNav(dom.doc.body)

  const nav = dom.doc.getElementById('dsh-chat-gutter-nav')
  const panel = dom.doc.querySelector('[data-dcg-panel]')
  const button = nav.querySelector('[data-dsh-gutter-nav-btn]')
  button.dispatchEvent({ type: 'click' })

  const cats = panel.querySelectorAll('[data-dcg-cat]')
  cats.find((item) => item.getAttribute('data-dcg-cat') === 'ask').dispatchEvent({ type: 'click' })
  const entry = panel.querySelector('[data-dcg-list]').querySelectorAll('[data-dcg-entry]')[0]
  entry.dispatchEvent({ type: 'click' })

  // 470 - 100（容器上边）- 96（顶部留白）= 274。
  assert.equal(dom.scroller.scrollTop, 274)
  assert.equal(row.lastScrollIntoView, undefined)

  dispose()
})

test('快速移动面板：面板挂在 body 下，插槽里只剩按钮，收起后整块移除', async () => {
  const dom = buildPanelDom()
  const slot = dom.doc.createElement('div')
  slot.setAttribute('data-slot', 'conversation.input.left')
  dom.doc.body.appendChild(slot)

  const { exports } = loadClient({ window: makeWindowStub(), document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)
  exports.__test.mountNav(slot)

  const nav = dom.doc.getElementById('dsh-chat-gutter-nav')
  assert.equal(nav.parentNode, slot)
  const panel = dom.doc.querySelector('[data-dcg-panel]')
  assert.notEqual(panel, null)
  assert.equal(panel.parentNode, dom.doc.body)
  assert.equal(nav.querySelector('[data-dcg-panel]'), null)

  // 打开后仍留在 body 下：定位靠 fixed，不进插槽、不参与输入区排版。
  nav.querySelector('[data-dsh-gutter-nav-btn]').dispatchEvent({ type: 'click' })
  assert.equal(panel.style.display, 'flex')
  assert.equal(panel.parentNode, dom.doc.body)

  dispose()
  assert.equal(dom.doc.querySelector('[data-dcg-panel]'), null)
})

test('快速移动面板：样式表按当前版本刷新，热替换留下的旧样式不留在页面上', async () => {
  const dom = buildPanelDom()
  const stale = dom.doc.createElement('style')
  stale.setAttribute('id', 'dsh-chat-gutter-style')
  stale.textContent = '.dcg-nav-btn{display:inline-flex}'
  dom.doc.head.appendChild(stale)

  const { exports } = loadClient({ window: makeWindowStub(), document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  // 复用同一个 style 节点，但内容必须换成本版——否则新加的规则永远进不了页面。
  const style = dom.doc.getElementById('dsh-chat-gutter-style')
  assert.equal(style, stale)
  assert.ok(String(style.textContent).includes('.dcg-panel{'))
  assert.ok(String(style.textContent).includes('.dcg-entry{'))
  assert.ok(String(style.textContent).includes('.dcg-panel-cats{'))

  dispose()
})

test('快速移动面板：热替换留下的旧 DOM 拆掉重建，页面上只剩一份面板', async () => {
  const dom = buildPanelDom()
  const first = loadClient({ window: makeWindowStub(), document: dom.doc })
  const dispose1 = first.exports.apply(buildCtx().ctx)
  first.exports.__test.mountNav(dom.doc.body)
  const nav1 = dom.doc.getElementById('dsh-chat-gutter-nav')

  const second = loadClient({ window: makeWindowStub(), document: dom.doc })
  const dispose2 = second.exports.apply(buildCtx().ctx)
  second.exports.__test.mountNav(dom.doc.body)
  const nav2 = dom.doc.getElementById('dsh-chat-gutter-nav')

  // 旧节点连它的旧监听一起作废：新代码必须管到自己建的那一份。
  assert.notEqual(nav2, nav1)
  assert.equal(dom.doc.querySelectorAll('[data-dcg-panel]').length, 1)
  assert.equal(nav2.querySelectorAll('[data-dcg-panel]').length, 0)

  dispose2()
  dispose1()
})

test('快速移动面板：收起的过程组仍进面板，按组文案归到提问/工具', async () => {
  const dom = buildPanelDom({ withQuestion: false })
  // 收起的回合：过程组整块带 hidden（屏幕上只剩一条汇总行），组里的提问不能跟着消失。
  const seat = dom.doc.createElement('div')
  seat.setAttribute('data-chat-flow-key', 'g9')
  seat.setAttribute('data-chat-turn', '2')
  seat.setAttribute('data-step-process', 'true')
  seat.setAttribute('hidden', 'until-found')
  seat.rect = rect(300, 700, 600, 0)
  seat.textContent = '向用户提出了问题提问1/1 已回答'
  dom.flow.appendChild(seat)

  const ui = await openPanelIn(dom)
  ui.button.dispatchEvent({ type: 'click' })

  const cats = ui.panel.querySelectorAll('[data-dcg-cat]')
  const question = cats.find((item) => item.getAttribute('data-dcg-cat') === 'question')
  assert.equal(question.getAttribute('data-count'), '1')

  question.dispatchEvent({ type: 'click' })
  const entries = ui.panel.querySelector('[data-dcg-list]').querySelectorAll('[data-dcg-entry]')
  assert.equal(entries.length, 1)
  assert.match(entries[0].textContent, /^1 · 向用户提出了问题/)

  ui.dispose()
})

test('快速移动面板：点收起组的编号先派发 beforematch 展开，再滚到那一行', async () => {
  const dom = buildPanelDom({ withQuestion: false })
  const seat = dom.doc.createElement('div')
  seat.setAttribute('data-chat-flow-key', 'g9')
  seat.setAttribute('data-chat-turn', '2')
  seat.setAttribute('data-step-process', 'true')
  seat.setAttribute('hidden', 'until-found')
  seat.rect = rect(300, 700, 600, 0)
  seat.textContent = '向用户提出了问题提问1/1 已回答'
  let reveals = 0
  // 官方在带 hidden 的元素上挂 beforematch，收到就展开（见 ui-chat 的 searchable-hidden）。
  seat.addEventListener('beforematch', () => {
    reveals += 1
    seat.removeAttribute('hidden')
    seat.rect = rect(300, 700, 600, 26)
  })
  dom.flow.appendChild(seat)

  const ui = await openPanelIn(dom)
  ui.button.dispatchEvent({ type: 'click' })
  const cats = ui.panel.querySelectorAll('[data-dcg-cat]')
  cats.find((item) => item.getAttribute('data-dcg-cat') === 'question').dispatchEvent({ type: 'click' })
  const entry = ui.panel.querySelector('[data-dcg-list]').querySelectorAll('[data-dcg-entry]')[0]
  entry.dispatchEvent({ type: 'click' })

  // 先展开，等展开后的那一帧再量位置：此刻还没滚。
  assert.equal(reveals, 1)
  assert.equal(seat.lastScrollIntoView, undefined)
  await sleep(200)
  assert.notEqual(seat.lastScrollIntoView, undefined)

  ui.dispose()
})

test('快速移动面板：过程组条目跳过组头，显示组里的真实内容', async () => {
  const dom = buildPanelDom({ withQuestion: false })
  // 真机结构：席位 ＝ 组头 ＋ [data-step-process-body]（组里第一行才是真实内容）。
  const seat = dom.doc.createElement('div')
  seat.setAttribute('data-chat-flow-key', 'g7')
  seat.setAttribute('data-chat-turn', '2')
  seat.setAttribute('data-step-process', 'true')
  seat.rect = rect(300, 600, 600, 26)
  const header = dom.doc.createElement('div')
  header.textContent = '已调用工具，已读取文件，已写入文件等'
  const body = dom.doc.createElement('div')
  body.setAttribute('data-step-process-body', '')
  const content = dom.doc.createElement('div')
  content.setAttribute('data-step-process-content', '')
  const firstRow = dom.doc.createElement('div')
  firstRow.textContent = '读取 handoff-1024-2032-插件B标识带.md'
  content.appendChild(firstRow)
  body.appendChild(content)
  seat.appendChild(header)
  seat.appendChild(body)
  dom.flow.appendChild(seat)

  const ui = await openPanelIn(dom)
  ui.button.dispatchEvent({ type: 'click' })
  const cats = ui.panel.querySelectorAll('[data-dcg-cat]')
  cats.find((item) => item.getAttribute('data-dcg-cat') === 'tool').dispatchEvent({ type: 'click' })
  const entries = ui.panel.querySelector('[data-dcg-list]').querySelectorAll('[data-dcg-entry]')
  const hit = entries.find((item) => item.textContent.includes('handoff'))
  assert.notEqual(hit, undefined)
  // 工具类前面已有小结行与命令行，这条排第 3；文案从组内容起头，不带「已调用工具…」。
  assert.match(hit.textContent, /^3 · 读取 handoff/)
  assert.ok(!hit.textContent.includes('已调用工具'))

  ui.dispose()
})

test('快速移动面板：路径只差文件名时，摘要取末尾，两条能分清', async () => {
  const dom = buildPanelDom({ withQuestion: false })
  for (const name of ['one.md', 'two.md']) {
    const seat = dom.doc.createElement('div')
    seat.setAttribute('data-chat-flow-key', 'g-' + name)
    seat.setAttribute('data-step-process', 'true')
    seat.rect = rect(300, 600, 600, 26)
    const body = dom.doc.createElement('div')
    body.setAttribute('data-step-process-body', '')
    const row = dom.doc.createElement('div')
    row.textContent = '读取F:\\01AI\\01software\\00文档MD backup\\handoff backup\\' + name
    body.appendChild(row)
    seat.appendChild(body)
    dom.flow.appendChild(seat)
  }

  const ui = await openPanelIn(dom)
  ui.button.dispatchEvent({ type: 'click' })
  const cats = ui.panel.querySelectorAll('[data-dcg-cat]')
  cats.find((item) => item.getAttribute('data-dcg-cat') === 'tool').dispatchEvent({ type: 'click' })
  const entries = ui.panel.querySelector('[data-dcg-list]').querySelectorAll('[data-dcg-entry]')
  const texts = entries.map((item) => item.textContent)
  const one = texts.find((text) => text.endsWith('one.md'))
  const two = texts.find((text) => text.endsWith('two.md'))
  assert.notEqual(one, undefined)
  assert.notEqual(two, undefined)
  assert.notEqual(one, two)

  ui.dispose()
})

test('过程组收起后徽标仍在：隐藏行计入 ⚙️/🧐，锚点退到组根元素', async () => {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 800)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: 100, height: 30, text: '你好' })
  // 过程组：内部工具行收起（hidden），组头折叠条仍可见（真实页面收起时组根不隐藏）。
  const group = doc.createElement('div')
  group.setAttribute('data-step-process', 'true')
  group.setAttribute('data-chat-turn', '1')
  group.rect = rect(300, 140, 600, 20)
  const toolRow = doc.createElement('div')
  toolRow.setAttribute('data-chat-flow-key', 'tool-collapsed')
  toolRow.setAttribute('data-chat-node-key', 'tool-collapsed')
  toolRow.setAttribute('data-chat-flow-kind', 'tool-call')
  toolRow.setAttribute('data-chat-turn', '1')
  toolRow.setAttribute('hidden', '')
  toolRow.rect = rect(300, 140, 600, 0)
  toolRow.textContent = '收起的工具'
  group.appendChild(toolRow)
  flow.appendChild(group)

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const texts = bandTexts(doc, 'dsh-chat-gutter')
  assert.ok(texts.includes('⚙️1'), '收起后仍应有 ⚙️1: ' + JSON.stringify(texts))

  dispose()
})

test('回合汇总条是首选锚点：data-turn-process 收起也在，工具数用官方计数', async () => {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 800)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '7', kind: 'user', top: 100, height: 30, text: '你好' })
  // 回合收起后的官方汇总条（TurnProcessNodeView 的按钮）。
  const summary = doc.createElement('div')
  summary.setAttribute('data-chat-flow-key', 'tp-7')
  summary.setAttribute('data-chat-node-key', 'tp-7')
  summary.setAttribute('data-chat-flow-kind', 'turn-process')
  summary.setAttribute('data-chat-turn', '7')
  summary.setAttribute('data-turn-process', '7')
  summary.setAttribute('data-turn-process-tool-calls', '12')
  summary.rect = rect(300, 140, 600, 33)
  flow.appendChild(summary)

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const texts = bandTexts(doc, 'dsh-chat-gutter')
  assert.ok(texts.includes('⚙️12'), '应直接用官方计数 ⚙️12: ' + JSON.stringify(texts))

  dispose()
})

test('过程徽标垂直居中：徽标中心钉在锚点行的可视中线上', async () => {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 800)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: 100, height: 30, text: '你好' })
  addRow(doc, flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: 150, height: 40, text: '调用工具' })

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const badge = bandMarkers(doc, 'dsh-chat-gutter').find((marker) => String(marker.textContent).startsWith('⚙️'))
  assert.notEqual(badge, undefined)
  // 行 150..190，中线 170；徽标自身用 CSS translateY(-50%) 居中到这个点，字号变化也不歪。
  assert.equal(badge.style.top, '170px')
  assert.match(exports.__test.styleSheet, /\.dcg-badge\{[^}]*translateY\(-50%\)/)

  dispose()
})

test('▶答 钉在弧线中点：整段弧线的垂直中心，而不是段首行', async () => {
  const dom = buildDom()
  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  const answers = bandMarkers(dom.doc, 'dsh-chat-gutter').filter((marker) => marker.textContent === '▶答')
  assert.equal(answers.length, 2)
  // turn1 段：a1(220..300) + a2(320..380) → 弧线 216..384 → 中点 300。
  // turn2 段：a3(530..590) → 弧线 526..594 → 中点 560。
  assert.equal(answers[0].style.top, '300px')
  assert.equal(answers[1].style.top, '560px')

  dispose()
})

test('弧线中点滚出屏幕时，▶答 贴在弧线可见部分的边缘跟着走', async () => {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 800)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: 60, height: 30, text: '你好' })
  addRow(doc, flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: 100, height: 30, text: '干活' })
  addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: 140, height: 100, text: '开头' })
  addRow(doc, flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: 1900, height: 100, text: '结尾' })

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  // 段落弧线 136..2004，真中点 1070 已经滚到可视区（0..800）下方，
  // ▶答 贴到可见部分的下缘（800 - 半颗徽标 10 = 790），不许先消失。
  const answer = bandMarkers(doc, 'dsh-chat-gutter').find((marker) => marker.textContent === '▶答')
  assert.notEqual(answer, undefined)
  assert.equal(answer.style.top, '790px')

  dispose()
})

test('弧线按内容长度画：超出正文可视区的部分交给覆盖层裁剪', async () => {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 80, 600, 700)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: 100, height: 30, text: '你好' })
  addRow(doc, flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: 140, height: 30, text: '干活' })
  addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: 180, height: 100, text: '开头' })
  addRow(doc, flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: 1300, height: 100, text: '结尾' })

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const svg = doc.getElementById('dsh-chat-gutter').children.find((child) => child.className === 'dcg-answer-arc')
  assert.notEqual(svg, undefined)
  // 段落 180..1400，弧线两端各外延 4px → 176..1404，高 1228：长度按段落真实长度算、
  // 不随滚动伸缩；超出正文可视区（80..780）的部分由覆盖层 clip-path 裁掉。
  assert.equal(svg.style.top, '176px')
  assert.equal(svg.style.height, '1228px')
  const viewBox = svg.getAttribute('viewBox')
  assert.equal(viewBox, '0 0 12 1228')
  assert.equal(doc.getElementById('dsh-chat-gutter').style.clipPath, 'inset(80px 0px 120px 0px)')
  const d = svg.children[0].getAttribute('d')
  const nums = d.match(/-?[\d.]+/g).map(Number)
  const ys = nums.filter((_, i) => i % 2 === 1)
  assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= 1228, '花瓣必须画在弧线自己的长度内: ' + d)

  dispose()
})

test('弧线整段滚出正文可视区时，弧线与 ▶答 一起消失', async () => {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 800)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: -2000, height: 30, text: '你好' })
  addRow(doc, flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: -1900, height: 30, text: '干活' })
  addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: -1800, height: 100, text: '开头' })
  addRow(doc, flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: -1600, height: 100, text: '结尾' })

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const svg = doc.getElementById('dsh-chat-gutter').children.find((child) => child.className === 'dcg-answer-arc')
  assert.equal(svg.style.display, 'none')
  const answer = bandMarkers(doc, 'dsh-chat-gutter').find((marker) => marker.textContent === '▶答')
  assert.equal(answer.style.display, 'none')

  dispose()
})

test('裁剪线取真正的滚动容器：父列比屏幕高时不能拿它当裁剪线', async () => {
  const doc = new FakeDocument()
  // 官方结构：滚动容器（overflow-y:auto，可见区 100..600）> 父列（装全部内容，已滚上去）> 聊天流（display:contents）
  const scroll = doc.createElement('div')
  scroll.rect = rect(300, 100, 600, 500)
  doc.body.appendChild(scroll)
  const column = doc.createElement('div')
  column.rect = rect(300, -400, 600, 2000)
  scroll.appendChild(column)
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(0, 0, 0, 0)
  column.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: -320, height: 30, text: '问' })
  addRow(doc, flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: -280, height: 30, text: '干活' })
  addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: -240, height: 120, text: '开头' })
  addRow(doc, flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: 460, height: 40, text: '结尾' })

  const windowStub = makeWindowStub()
  windowStub.getComputedStyle = (el) => ({ overflowY: el === scroll ? 'auto' : 'visible' })
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const svg = doc.getElementById('dsh-chat-gutter').children.find((child) => child.className === 'dcg-answer-arc')
  assert.notEqual(svg, undefined)
  // 弧线自然范围 -244..504（高 748，长度与段落一致），裁剪交给覆盖层。
  assert.equal(svg.style.top, '-244px')
  assert.equal(svg.style.height, '748px')
  assert.equal(doc.getElementById('dsh-chat-gutter').style.clipPath, 'inset(100px 0px 300px 0px)')
  const answer = bandMarkers(doc, 'dsh-chat-gutter').find((marker) => marker.textContent === '▶答')
  assert.notEqual(answer, undefined)
  assert.equal(answer.style.display, '')
  // 段落真中点 130，落在可视区 100..600 里 → 直接钉在 130。
  assert.equal(answer.style.top, '130px')

  dispose()
})

test('段首行滚出屏幕但弧线还可见时，▶答 不许先消失', async () => {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 600)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: -520, height: 30, text: '问' })
  addRow(doc, flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: -480, height: 30, text: '干活' })
  addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: -300, height: 100, text: '开头' })
  addRow(doc, flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: -210, height: 60, text: '结尾' })

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const answer = bandMarkers(doc, 'dsh-chat-gutter').find((marker) => marker.textContent === '▶答')
  assert.notEqual(answer, undefined)
  // 弧线自然 -304..-146，整体都在裁剪窗口（0..600）上方 → 弧线消失，▶答 一起消失。
  assert.equal(answer.style.display, 'none')

  dispose()
})

test('汇总条徽标对齐官方文字：量按钮里文字 span 的实际中线', async () => {
  const doc = new FakeDocument()
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(300, 0, 600, 800)
  doc.body.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '7', kind: 'user', top: 100, height: 30, text: '你好' })
  // 官方结构：flowItem 行 > button[data-turn-process]（高 33px、底部 8px 内边距）> span 文字。
  const summary = doc.createElement('div')
  summary.setAttribute('data-chat-flow-key', 'tp-7')
  summary.setAttribute('data-chat-flow-kind', 'turn-process')
  summary.setAttribute('data-chat-turn', '7')
  summary.setAttribute('data-turn-process-tool-calls', '12')
  summary.rect = rect(300, 400, 600, 33)
  const button = doc.createElement('button')
  button.setAttribute('data-turn-process', '7')
  button.rect = rect(300, 400, 600, 33)
  const label = doc.createElement('span')
  label.rect = rect(300, 400, 200, 20)
  button.appendChild(label)
  summary.appendChild(button)
  flow.appendChild(summary)

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const badge = bandMarkers(doc, 'dsh-chat-gutter').find((marker) => String(marker.textContent).startsWith('⚙️'))
  assert.notEqual(badge, undefined)
  // 文字 span 的盒子 400..420，中心 410 —— 徽标中心必须钉在这里。
  assert.equal(badge.style.top, '410px')

  dispose()
})

test('回答段整段弧线：填充花瓣形，中段有厚度、上下收尖、向左深鼓', async () => {
  const dom = buildDom()
  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  const svgs = dom.doc.getElementById('dsh-chat-gutter').children.filter((child) => child.className === 'dcg-answer-arc')
  assert.equal(svgs.length, 2)
  for (const svg of svgs) {
    const d = svg.children[0].getAttribute('d')
    // M 上尖端 → Q 外缘（向左深鼓）→ 下尖端 → Q 内缘回到上尖端 → Z 闭合。
    const nums = d.match(/-?[\d.]+/g).map(Number)
    assert.equal(nums.length, 10, '应为 M(2) + Q(4) + Q(4) 的闭合花瓣: ' + d)
    const [x0, y0, cx1, , x2, y2, cx2, , x3, y3] = nums
    assert.ok(Math.abs(y3 - y0) < 0.01 && Math.abs(x3 - x0) < 0.01, '应闭合回上尖端: ' + d)
    assert.ok(y2 - y0 > 40, '两个尖端应上下拉开: ' + d)
    assert.ok(Math.abs(x2 - x0) < 0.01, '两个尖端在同一竖线上: ' + d)
    assert.ok(cx1 < Math.min(x0, x2), '外缘控制点应比尖端更靠左（向左深鼓）: ' + d)
    assert.ok(cx2 > cx1 && cx2 < x0, '内缘应比外缘直但仍向左弯: ' + d)
    assert.ok(cx2 - cx1 >= 4, '中段厚度至少 2px（控制点差/2）: ' + d)
  }

  dispose()
})

test('滚动零延迟：滚动只重算弧线几何（rAF 逐帧），不排全量扫描任务', async () => {
  const dom = buildDom()
  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  // 模拟滚动：正文可视区（flow 盒）与所有行整体下移 500，派发 scroll。
  const rows = dom.flow.querySelectorAll('[data-chat-flow-key]')
  dom.flow.rect = rect(300, 500, 600, 800)
  for (const row of rows) { row.rect.top += 500; row.rect.bottom += 500 }
  windowStub.dispatch('scroll')
  await sleep(30) // rAF 桩走 setTimeout 0，30ms 足够跑完一帧

  // 弧线跟上了新坐标：turn1 段 a1 上端 720 → 弧线顶 716（仍在可视区 500..900 内）；
  // turn2 段随行滚到可视区下方，弧线不再画到窗口外（旧行为会画到 1026）。
  const arcs = dom.doc.getElementById('dsh-chat-gutter').children.filter((child) => child.className === 'dcg-answer-arc')
  assert.equal(arcs.length, 2)
  const shown = arcs.filter((arc) => arc.style.display !== 'none')
  assert.equal(shown.length, 1)
  assert.equal(shown[0].style.top, '716px')
  assert.equal(arcs.filter((arc) => arc.style.display === 'none').length, 1)

  // 滚动不排扫描：scanTimer 应保持空（没有 120ms 节流的扫描任务）。
  assert.equal(exports.__test.stateForTest().scanTimer, null)

  dispose()
})

// 真机九层结构（2026-10-23 真机实测）：
//   聊天流(display:contents，盒高 0) → 消息列 → xz4KEq_scroll → xz4KEq_root(overflow:clip)
//   → xz4KEq_frame → conversation.view(contents) → viewArea → conversation.session(contents)
//   → 滚动容器 Dc7zOa_scrollBody(overflow-y:auto, data-conversation-scroll)
// 滚动容器正好是第 9 个盒子（深度 8），它上面三层内容盒都比屏幕高。
function buildRealChain(options = {}) {
  const attribute = options.attribute !== false
  const scrollerTop = options.scrollerTop ?? 100
  const scrollerHeight = options.scrollerHeight ?? 500
  const columnTop = options.columnTop ?? -400
  const columnHeight = options.columnHeight ?? 2000

  const doc = new FakeDocument()
  const scroller = doc.createElement('div')
  scroller.setAttribute('class', 'Dc7zOa_scrollBody')
  if (attribute) scroller.setAttribute('data-conversation-scroll', '')
  scroller.rect = rect(300, scrollerTop, 600, scrollerHeight)
  doc.body.appendChild(scroller)

  const session = doc.createElement('div')
  session.setAttribute('data-slot', 'conversation.session')
  session.rect = rect(0, 0, 0, 0)
  scroller.appendChild(session)

  const viewArea = doc.createElement('div')
  viewArea.setAttribute('class', 'Dc7zOa_viewArea')
  viewArea.rect = rect(300, columnTop, 600, columnHeight)
  session.appendChild(viewArea)

  const view = doc.createElement('div')
  view.setAttribute('data-slot', 'conversation.view')
  view.rect = rect(0, 0, 0, 0)
  viewArea.appendChild(view)

  const frame = doc.createElement('div')
  frame.setAttribute('class', 'xz4KEq_frame')
  frame.rect = rect(300, columnTop, 600, columnHeight)
  view.appendChild(frame)

  const root = doc.createElement('div')
  root.setAttribute('class', 'xz4KEq_root')
  root.rect = rect(300, columnTop, 600, columnHeight)
  frame.appendChild(root)

  const scroll = doc.createElement('div')
  scroll.setAttribute('class', 'xz4KEq_scroll')
  scroll.rect = rect(300, columnTop - 16, 600, columnHeight + 32)
  root.appendChild(scroll)

  const column = doc.createElement('div')
  column.setAttribute('class', 'xz4KEq_column')
  column.rect = rect(300, columnTop, 600, columnHeight)
  scroll.appendChild(column)

  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(0, 0, 0, 0)
  column.appendChild(flow)

  const windowStub = makeWindowStub()
  windowStub.getComputedStyle = (element) => ({
    overflowY: element === scroller ? 'auto' : element === root ? 'clip' : 'visible',
  })
  return { doc, flow, scroller, column, windowStub }
}

test('真机九层结构：滚动容器在第 8 层也要认出来，覆盖层裁到它的上下边', async () => {
  const dom = buildRealChain()
  addRow(dom.doc, dom.flow, { key: 'u1', turn: '1', kind: 'user', top: -320, height: 30, text: '问' })
  addRow(dom.doc, dom.flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: -280, height: 30, text: '干活' })
  addRow(dom.doc, dom.flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: -240, height: 120, text: '开头' })
  addRow(dom.doc, dom.flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: 460, height: 40, text: '结尾' })

  const { exports } = loadClient({ window: dom.windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  const svg = dom.doc.getElementById('dsh-chat-gutter').children.find((child) => child.className === 'dcg-answer-arc')
  assert.notEqual(svg, undefined)
  // 弧线按段落真实长度 748 画（-244..504），覆盖层裁到滚动容器 100..600。
  assert.equal(svg.style.top, '-244px')
  assert.equal(svg.style.height, '748px')
  assert.equal(dom.doc.getElementById('dsh-chat-gutter').style.clipPath, 'inset(100px 0px 300px 0px)')
  const answer = bandMarkers(dom.doc, 'dsh-chat-gutter').find((marker) => marker.textContent === '▶答')
  assert.notEqual(answer, undefined)
  // 段落真中点 130，落在可视区里 → 钉在 130。
  assert.equal(answer.style.top, '130px')

  dispose()
})

test('没有 data-conversation-scroll 时，按 overflow 往上找要走到第 8 层', async () => {
  const dom = buildRealChain({ attribute: false })
  addRow(dom.doc, dom.flow, { key: 'u1', turn: '1', kind: 'user', top: -320, height: 30, text: '问' })
  addRow(dom.doc, dom.flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: -280, height: 30, text: '干活' })
  addRow(dom.doc, dom.flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: -240, height: 120, text: '开头' })
  addRow(dom.doc, dom.flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: 460, height: 40, text: '结尾' })

  const { exports } = loadClient({ window: dom.windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  const svg = dom.doc.getElementById('dsh-chat-gutter').children.find((child) => child.className === 'dcg-answer-arc')
  assert.notEqual(svg, undefined)
  assert.equal(svg.style.top, '-244px')
  assert.equal(svg.style.height, '748px')
  assert.equal(dom.doc.getElementById('dsh-chat-gutter').style.clipPath, 'inset(100px 0px 300px 0px)')

  dispose()
})

test('找不到滚动容器时，比窗口还高的内容列不能当裁剪线，退回屏幕可视区', async () => {
  const doc = new FakeDocument()
  const column = doc.createElement('div')
  column.setAttribute('class', 'xz4KEq_column')
  column.rect = rect(300, -400, 600, 2000)
  doc.body.appendChild(column)
  const flow = doc.createElement('div')
  flow.setAttribute('data-slot', 'conversation.chat.flow')
  flow.rect = rect(0, 0, 0, 0)
  column.appendChild(flow)

  addRow(doc, flow, { key: 'u1', turn: '1', kind: 'user', top: -320, height: 30, text: '问' })
  addRow(doc, flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: -280, height: 30, text: '干活' })
  addRow(doc, flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: -240, height: 120, text: '开头' })
  addRow(doc, flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: 460, height: 40, text: '结尾' })

  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const dispose = exports.apply(buildCtx().ctx)

  const svg = doc.getElementById('dsh-chat-gutter').children.find((child) => child.className === 'dcg-answer-arc')
  assert.notEqual(svg, undefined)
  // 内容列 -400..1600 比窗口高 → 不作裁剪线，改用屏幕 0..900；弧线仍按段落真实长度 748 画。
  assert.equal(svg.style.top, '-244px')
  assert.equal(svg.style.height, '748px')
  assert.equal(doc.getElementById('dsh-chat-gutter').style.clipPath, 'inset(0px 0px 0px 0px)')

  dispose()
})

test('整段回答滚到正文上方时，▶答 不许钉在窗口最上面', async () => {
  const dom = buildRealChain({ scrollerTop: 116, scrollerHeight: 988, columnTop: -4169, columnHeight: 5125 })
  addRow(dom.doc, dom.flow, { key: 'u1', turn: '1', kind: 'user', top: -4139, height: 30, text: '问' })
  addRow(dom.doc, dom.flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: -3897, height: 30, text: '干活' })
  addRow(dom.doc, dom.flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: -3843, height: 3279, text: '长长的回答' })

  const { exports } = loadClient({ window: dom.windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  // 这一段回答整体在滚动容器（可见区 116..1104）上方 → 弧线与 ▶答 一起消失，
  // 不允许把中点夹到窗口顶上（真机表现为 y=14 的那个浮在最上面的「答」）。
  const svg = dom.doc.getElementById('dsh-chat-gutter').children.find((child) => child.className === 'dcg-answer-arc')
  assert.equal(svg.style.display, 'none')
  const answer = bandMarkers(dom.doc, 'dsh-chat-gutter').find((marker) => marker.textContent === '▶答')
  assert.equal(answer.style.display, 'none')
  assert.notEqual(answer.style.top, '14px')

  dispose()
})

test('过程徽标不许画到标题栏里：锚点行滑到正文顶上沿之外就隐藏', async () => {
  const dom = buildRealChain()
  // turn1 的干活行已经滑到正文顶上沿（100）之外；turn2 的干活行还在正文中间。
  addRow(dom.doc, dom.flow, { key: 'u1', turn: '1', kind: 'user', top: -320, height: 30, text: '问' })
  addRow(dom.doc, dom.flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: 30, height: 40, text: '干活' })
  addRow(dom.doc, dom.flow, { key: 'u2', turn: '2', kind: 'user', top: 150, height: 30, text: '再问' })
  addRow(dom.doc, dom.flow, { key: 'tool2', turn: '2', kind: 'tool-call', top: 300, height: 40, text: '再干活' })

  const { exports } = loadClient({ window: dom.windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  const badges = bandMarkers(dom.doc, 'dsh-chat-gutter').filter((marker) => String(marker.textContent).startsWith('⚙️'))
  assert.equal(badges.length, 2)
  const shown = badges.filter((badge) => badge.style.display !== 'none')
  // 只剩正文里那个；标题栏里那个（行中线 50 < 100）必须隐藏。
  assert.equal(shown.length, 1)
  assert.equal(shown[0].style.top, '320px')

  dispose()
})

test('弧线长度不随滚动变化：段落多长弧线就多长，只是跟着内容上下移动', async () => {
  const dom = buildRealChain({ scrollerTop: 116, scrollerHeight: 988, columnTop: -400, columnHeight: 3000 })
  addRow(dom.doc, dom.flow, { key: 'u1', turn: '1', kind: 'user', top: 200, height: 30, text: '问' })
  addRow(dom.doc, dom.flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: 250, height: 30, text: '干活' })
  addRow(dom.doc, dom.flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: 300, height: 100, text: '开头' })
  addRow(dom.doc, dom.flow, { key: 'a2', turn: '1', kind: 'assistant-step', top: 900, height: 100, text: '结尾' })

  const { exports } = loadClient({ window: dom.windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  const arc = () => dom.doc.getElementById('dsh-chat-gutter').children.find((child) => child.className === 'dcg-answer-arc')
  // 段落 300..1000，弧线两端各外延 4px → 296..1004，高 708。
  assert.equal(arc().style.top, '296px')
  assert.equal(arc().style.height, '708px')

  // 内容往上滚 500：弧线只是跟着上移，长度一点不变（不能按可视区裁剪）。
  const rows = dom.flow.querySelectorAll('[data-chat-flow-key]')
  for (const row of rows) { row.rect.top -= 500; row.rect.bottom -= 500 }
  dom.windowStub.dispatch('scroll')
  await sleep(30)

  assert.equal(arc().style.top, '-204px')
  assert.equal(arc().style.height, '708px')
  assert.equal(arc().getAttribute('viewBox'), '0 0 12 708')

  dispose()
})

test('覆盖层自己就裁在正文可视区：徽标/弧线根本画不到标题栏', async () => {
  const dom = buildRealChain()
  addRow(dom.doc, dom.flow, { key: 'u1', turn: '1', kind: 'user', top: 120, height: 30, text: '问' })
  addRow(dom.doc, dom.flow, { key: 'tool1', turn: '1', kind: 'tool-call', top: 200, height: 40, text: '干活' })
  addRow(dom.doc, dom.flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: 300, height: 100, text: '答' })

  const { exports } = loadClient({ window: dom.windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  // 滚动容器 100..600，窗口高 900 → 覆盖层只保留 100..600 这一段。
  const overlay = dom.doc.getElementById('dsh-chat-gutter')
  assert.equal(overlay.style.clipPath, 'inset(100px 0px 300px 0px)')
  const overlayRight = dom.doc.getElementById('dsh-chat-gutter-right')
  assert.equal(overlayRight.style.clipPath, 'inset(100px 0px 300px 0px)')

  dispose()
})

test('覆盖层裁剪值不变就不重写：浏览器会把 clip-path 归一化，不能每帧重刷', async () => {
  const dom = buildRealChain()
  addRow(dom.doc, dom.flow, { key: 'u1', turn: '1', kind: 'user', top: 120, height: 30, text: '问' })
  addRow(dom.doc, dom.flow, { key: 'a1', turn: '1', kind: 'assistant-step', top: 300, height: 100, text: '答' })

  const { exports } = loadClient({ window: dom.windowStub, document: dom.doc })
  const dispose = exports.apply(buildCtx().ctx)

  // 真机 Chromium 把 inset(100px 0px 300px 0px) 读回成 inset(100px 0px 300px)：
  // 拿读回值当缓存会每帧重写一次，白丢一次样式重算。这里用同样归一化的代理重现它。
  const overlay = dom.doc.getElementById('dsh-chat-gutter')
  const style = overlay.style
  const normalize = (value) => String(value).replace(/ 0px\)$/, ')')
  style.clipPath = normalize(style.clipPath)
  let writes = 0
  overlay.style = new Proxy(style, {
    set(target, key, value) {
      if (key === 'clipPath') {
        writes += 1
        target[key] = normalize(value)
      } else {
        target[key] = value
      }
      return true
    },
  })

  dom.windowStub.dispatch('scroll')
  await sleep(30)
  dom.windowStub.dispatch('scroll')
  await sleep(30)

  assert.equal(writes, 0)

  dispose()
})
