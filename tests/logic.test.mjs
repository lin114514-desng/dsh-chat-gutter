// 先写行为检查，再实现 lib/client.js（红 → 绿）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './harness.mjs'

function api() {
  return loadClient().exports.__test
}

test('编号带落点：右侧留得下就贴内容右边缘，留不下返回 null', () => {
  const t = api()
  assert.equal(t.gutterRight(300, 600, 92, 8, 4, 1770), 908)
  assert.equal(t.gutterRight(300, 600, 92, 8, 4, 1000), null)
  assert.equal(t.gutterRight(Number.NaN, 600, 92, 8, 4, 1770), null)
  assert.equal(t.gutterRight(300, 0, 92, 8, 4, 1770), null)
})

test('过程徽标文案：⚙️工具 ⌨️命令 🧐思考分开计数，没有的类不写，全无则不出徽标', () => {
  const t = api()
  assert.equal(t.processBadgeText(12, 0, 5), '⚙️12 🧐5')
  assert.equal(t.processBadgeText(1, 2, 0), '⚙️1 ⌨️2')
  assert.equal(t.processBadgeText(0, 0, 3), '🧐3')
  assert.equal(t.processBadgeText(0, 0, 0), null)
})

test('面板分类：行类型映射到四类，认不出的返回 null', () => {
  const t = api()
  assert.equal(t.panelTypeOfKind('user'), 'ask')
  assert.equal(t.panelTypeOfKind('steering'), 'ask')
  assert.equal(t.panelTypeOfKind('turn-trigger'), 'ask')
  assert.equal(t.panelTypeOfKind('tool-call'), 'tool')
  assert.equal(t.panelTypeOfKind('tool-result'), 'tool')
  assert.equal(t.panelTypeOfKind('command'), 'tool')
  assert.equal(t.panelTypeOfKind('compaction'), 'tool')
  assert.equal(t.panelTypeOfKind('assistant-step'), 'answer')
  assert.equal(t.panelTypeOfKind('assistant'), 'answer')
  assert.equal(t.panelTypeOfKind('turn-process'), null)
  assert.equal(t.panelTypeOfKind('user-actions'), null)
  assert.equal(t.panelTypeOfKind(null), null)
})

test('过程小结行按文字分到「AI 提问」或「工具」', () => {
  const t = api()
  // 真机小结行文案：message.stepProcess.done.questions / .tools。
  assert.equal(t.questionSeatType('向用户提出了问题 提问5/5 已回答'), 'question')
  assert.equal(t.questionSeatType('已调用工具 ops_bash'), 'tool')
  assert.equal(t.questionSeatType('已读取文件 F:\\docs'), 'tool')
  assert.equal(t.questionSeatType(''), 'tool')
  assert.equal(t.questionSeatType(null), 'tool')
})

test('面板摘要：压掉空白、超长截断加省略号、空文字返回空串', () => {
  const t = api()
  assert.equal(t.excerptText('  你好   世界  ', 18), '你好 世界')
  assert.equal(t.excerptText('一二三四五六七八九十一二三四五六七八九十一', 18), '一二三四五六七八九十一二三四五六七八…')
  assert.equal(t.excerptText('', 18), '')
  assert.equal(t.excerptText(null, 18), '')
  assert.equal(t.excerptText('短', 18), '短')
})

test('回答按段合并：连续的回答行算一条，中间夹别的行就断开', () => {
  const t = api()
  const items = [
    { el: 'a1', type: 'answer', text: '第一段' },
    { el: 'a2', type: 'answer', text: '第二段' },
    { el: 'u1', type: 'ask', text: '插入' },
    { el: 'a3', type: 'answer', text: '第三段' },
    { el: 'a4', type: 'answer', text: '第四段' },
  ]
  const merged = t.mergeAnswerRuns(items)
  assert.deepEqual(merged.map((item) => item.type), ['answer', 'ask', 'answer'])
  assert.equal(merged[0].el, 'a1')
  assert.equal(merged[0].text, '第一段')
  assert.equal(merged[2].el, 'a3')
})

test('字号跟着界面字号变量走，不写死像素', () => {
  const t = api()
  assert.match(t.styleSheet, /--dsh-content-font-size-secondary/)
  assert.match(t.styleSheet, /--dsh-content-font-delta-secondary/)
  assert.doesNotMatch(t.styleSheet, /font-size:\s*11px/)
  assert.doesNotMatch(t.styleSheet, /font-size:\s*10px/)
})

test('默认配置：三项开启，回答起点默认「仅干完活后」', () => {
  const t = api()
  assert.deepEqual(
    { ...t.normalizeConfig(undefined) },
    { enabled: true, showNumbers: true, showBadges: true, answerMark: 'tools' },
  )
})

test('配置归一：布尔值只认 true/false，非法模式回退 tools，volatile ref 自动解包', () => {
  const t = api()
  const config = t.normalizeConfig({
    enabled: false,
    showNumbers: 'yes',
    showBadges: { get: () => false },
    answerMark: 'sometimes',
  })
  assert.equal(config.enabled, false)
  assert.equal(config.showNumbers, true)
  assert.equal(config.showBadges, false)
  assert.equal(config.answerMark, 'tools')
  assert.equal(t.normalizeConfig({ answerMark: 'always' }).answerMark, 'always')
  assert.equal(t.normalizeConfig({ answerMark: 'off' }).answerMark, 'off')
})

test('行级徽标：工具/命令/思考/压缩各归各，正文行没有徽标', () => {
  const t = api()
  assert.equal(t.badgeForKind('tool-call'), '⚙️工具')
  assert.equal(t.badgeForKind('tool-result'), '⚙️工具')
  assert.equal(t.badgeForKind('command'), '⌨️命令')
  assert.equal(t.badgeForKind('reasoning'), '🧐思考')
  assert.equal(t.badgeForKind('compaction'), '📦上下文压缩')
  assert.equal(t.badgeForKind('assistant-step'), null)
  assert.equal(t.badgeForKind('user'), null)
})

test('回答起点：关闭模式不标记任何行', () => {
  const t = api()
  const rows = [
    { key: 'tool', turn: '1', kind: 'tool-call', visible: true },
    { key: 'answer', turn: '1', kind: 'assistant-step', visible: true },
  ]
  assert.deepEqual(t.planAnswerMarks(rows, 'off'), [])
})

test('回答段：干完活模式标最后一个干活行之后的连续正文整段', () => {
  const t = api()
  const rows = [
    { key: 'intro', turn: '1', kind: 'assistant-step', visible: true },
    { key: 'tool1', turn: '1', kind: 'tool-call', visible: true },
    { key: 'tool2', turn: '1', kind: 'command', visible: true },
    { key: 'answer', turn: '1', kind: 'assistant-step', visible: true },
    { key: 'after', turn: '1', kind: 'assistant-step', visible: true },
  ]
  assert.deepEqual(t.planAnswerMarks(rows, 'tools'), ['answer', 'after'])
})

test('回答起点：没有干活行就不标；干活行在正文之后也不标', () => {
  const t = api()
  assert.deepEqual(t.planAnswerMarks([
    { key: 'a', turn: '1', kind: 'assistant-step', visible: true },
  ], 'tools'), [])
  assert.deepEqual(t.planAnswerMarks([
    { key: 'a', turn: '1', kind: 'assistant-step', visible: true },
    { key: 'tool', turn: '1', kind: 'tool-call', visible: true },
  ], 'tools'), [])
})

test('回答起点：思考行不算正文；折叠中不可见的第一段跳过，取下一段可见正文', () => {
  const t = api()
  const rows = [
    { key: 'tool', turn: '1', kind: 'tool-call', visible: true },
    { key: 'think', turn: '1', kind: 'assistant-step', groupPart: 'reasoning', visible: true },
    { key: 'hidden', turn: '1', kind: 'assistant-step', visible: false },
    { key: 'answer', turn: '1', kind: 'assistant-step', visible: true },
  ]
  assert.deepEqual(t.planAnswerMarks(rows, 'tools'), ['answer'])
})

test('回答起点：提问回复算干活行，每个回合各自判定', () => {
  const t = api()
  const rows = [
    { key: 'q1', turn: '1', kind: 'tool-result', questionReply: true, visible: true },
    { key: 'a1', turn: '1', kind: 'assistant-step', visible: true },
    { key: 'a2', turn: '2', kind: 'assistant-step', visible: true },
  ]
  assert.deepEqual(t.planAnswerMarks(rows, 'tools'), ['a1'])
})

test('回答段：总是模式每回合取第一段可见正文整段', () => {
  const t = api()
  const rows = [
    { key: 'a1', turn: '1', kind: 'assistant-step', groupPart: 'reasoning', visible: true },
    { key: 'a2', turn: '1', kind: 'assistant-step', visible: true },
    { key: 'a3', turn: '1', kind: 'assistant-step', visible: true },
    { key: 'b1', turn: '2', kind: 'assistant-step', visible: false },
    { key: 'b2', turn: '2', kind: 'assistant-step', visible: true },
    { key: 'b3', turn: '2', kind: 'assistant-step', visible: true },
  ]
  assert.deepEqual(t.planAnswerMarks(rows, 'always'), ['a2', 'a3', 'b2', 'b3'])
})

test('回答段不跨工作行：中间插了工具行就断开，标记跟最后一个干活行后的正文', () => {
  const t = api()
  const rows = [
    { key: 'u', turn: '1', kind: 'user', visible: true },
    { key: 'a1', turn: '1', kind: 'assistant-step', visible: true },
    { key: 'tool2', turn: '1', kind: 'tool-call', visible: true },
    { key: 'a2', turn: '1', kind: 'assistant-step', visible: true },
  ]
  // 干活行是 tool2：它之后的连续正文 a2 才是回答段；a1 在干活前不算。
  assert.deepEqual(t.planAnswerMarks(rows, 'tools'), ['a2'])
})

test('回答段样式：SVG 花瓣弧线（填充蓝、中厚端尖），不再用行内 ::before', () => {
  const t = api()
  assert.match(t.styleSheet, /dcg-answer-arc/)
  assert.match(t.styleSheet, /fill:var\(--dsw-specific-accent,#3b82f6\)/)
  assert.match(t.styleSheet, /#3b82f6/)
  assert.doesNotMatch(t.styleSheet, /stroke-width/)
  assert.doesNotMatch(t.styleSheet, /inset 3px 0 0 0 #f59e0b/)
  assert.doesNotMatch(t.styleSheet, /dcg-answer-line/)
})

test('标记排布：按 top 排序并保持最小间距，不改变顺序', () => {
  const t = api()
  const placed = t.layoutMarkers([
    { key: 'c', top: 140 },
    { key: 'a', top: 100 },
    { key: 'b', top: 104 },
  ], 18)
  assert.deepEqual(placed, [
    { key: 'a', top: 100 },
    { key: 'b', top: 118 },
    { key: 'c', top: 140 },
  ])
})

test('标识带左边距：空白不足时返回 null（整条带隐藏）', () => {
  const t = api()
  assert.equal(t.gutterLeft(300, 92, 8, 4), 200)
  assert.equal(t.gutterLeft(140, 92, 8, 4), 40)
  assert.equal(t.gutterLeft(100, 92, 8, 4), null)
  assert.equal(t.gutterLeft(0, 92, 8, 4), null)
})

test('apply 是函数且声明只依赖 slots 服务；配置页注册不依赖官方模块', () => {
  const { exports } = loadClient()
  assert.equal(exports.name, 'dsh-chat-gutter')
  assert.deepEqual([...exports.inject], ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('配置页的 form 是 { state, mutate }，直接取 state 快照；也兼容活控制器', () => {
  const t = api()
  const state = { status: 'ready', value: { enabled: false }, revision: 7, writable: true }
  const pageForm = { state, mutate: () => Promise.resolve(true) }
  assert.equal(t.readPageSnapshot(pageForm), state)

  const controller = { getSnapshot: () => ({ status: 'loading' }) }
  assert.equal(t.readPageSnapshot(controller).status, 'loading')
  assert.equal(t.readPageSnapshot(null), null)
})

test('配置页用 { state, mutate } 能渲染出四项控件，不卡在加载态', () => {
  const { exports } = loadClient()
  const page = exports.__test.ConfigPage({
    view: 'page',
    form: {
      state: {
        status: 'ready',
        value: { enabled: true, showNumbers: true, showBadges: true, answerMark: 'tools' },
        revision: 1,
        writable: true,
      },
      mutate: async () => true,
    },
  })
  assert.equal(page.type, 'div')
  const text = JSON.stringify(page)
  assert.ok(text.includes('启用左侧标识带'))
  assert.ok(text.includes('回合编号路标'))
  assert.ok(text.includes('行级徽标'))
  assert.ok(text.includes('回答起点高亮'))
  assert.ok(text.includes('保存'))

  const summary = exports.__test.ConfigPage({ view: 'summary' })
  assert.equal(summary.type, 'span')
})
