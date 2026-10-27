// 「AI 提问」条目的题干：官方两种节点形状（等待中 / 已回答）都要读得出来。
// 已回答时 root 变成 tool-result，入参挪到 root.call.argsRaw，比等待中多嵌一层。
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeDocument } from './fake-dom.mjs'
import { loadClient } from './harness.mjs'

const QUESTION = '请先强刷一次当前页面，然后看聊天区左侧那条竖带：现在有没有出现 #1 #2 #3 这样的回合编号？'
const HEADER = '页面确认'
const ARGS_RAW = JSON.stringify({
  questions: [
    {
      id: 'page_numbers',
      header: HEADER,
      question: QUESTION,
      multi_select: false,
      options: [{ label: '有编号', description: '正常' }, { label: '没有编号' }],
    },
  ],
})

function nodeWithRoot(root) {
  return { key: 'k1', kind: 'tool-call', data: { root } }
}

/** 调用进行中：入参原文挂在 root.argsRaw。 */
function pendingNode() {
  return nodeWithRoot({
    phase: 'start',
    callId: 'call_1',
    name: 'ask_user_question',
    argsRaw: ARGS_RAW,
    args: {},
    turn: 1,
    step: 1,
    time: 1,
    subCalls: [],
  })
}

/** 已回答：root 变成 tool-result，入参原文在 root.call.argsRaw。 */
function answeredNode() {
  return nodeWithRoot({
    kind: 'tool-result',
    seq: 10,
    time: 2,
    callId: 'call_1',
    name: 'ask_user_question',
    args: {},
    call: { name: 'ask_user_question', argsRaw: ARGS_RAW },
    callTime: 1,
    content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'page_numbers', selected: ['有编号'] }] }) }],
    isError: false,
    subCalls: [],
  })
}

/** 只有流式参数视图可用：args.value('questions') 直接给数组。 */
function argsViewNode() {
  return nodeWithRoot({
    kind: 'tool-result',
    seq: 10,
    time: 2,
    callId: 'call_1',
    name: 'ask_user_question',
    args: {
      value: (key) => (key === 'questions' ? [{ id: 'page_numbers', header: HEADER, question: QUESTION }] : undefined),
    },
    call: null,
    callTime: 1,
    content: [],
    isError: false,
    subCalls: [],
  })
}

function buildFlow(doc, chatNode, options = {}) {
  const flow = doc.createElement('div')
  const seat = doc.createElement('div')
  seat.setAttribute('data-chat-flow-key', 'group:1')
  seat.setAttribute('data-chat-group-key', 'group:1')
  seat.setAttribute('data-step-process', '')
  if (options.hidden === true) seat.setAttribute('hidden', 'until-found')
  seat.rect = { left: 0, top: 0, width: 800, height: 60, right: 800, bottom: 60 }

  const header = doc.createElement('div')
  header.textContent = options.headerText ?? '向用户提出了问题'
  seat.appendChild(header)

  const body = doc.createElement('div')
  body.setAttribute('data-step-process-body', '')
  const content = doc.createElement('div')
  content.setAttribute('data-step-process-content', '')
  body.appendChild(content)

  const row = doc.createElement('div')
  row.setAttribute('data-chat-flow-key', 'k1')
  row.setAttribute('data-chat-flow-kind', 'tool-call')
  row.setAttribute('data-chat-node-key', 'k1')
  row.textContent = options.rowText ?? '提问1/1 已回答'
  row.rect = { left: 0, top: 0, width: 700, height: 24, right: 700, bottom: 24 }
  if (options.marker === true) {
    // 官方提问行内部挂着这个标记，和界面语言无关。
    const marker = doc.createElement('div')
    marker.setAttribute('data-tool', 'ask_user_question')
    row.appendChild(marker)
  }
  // 真机：行是 ChatNodeSeat 的根节点，parent fiber 的 props 里有 nodeStore。
  row['__reactFiber$test'] = {
    memoizedProps: { className: 'row' },
    return: { memoizedProps: { nodeStore: { byKey: new Map([['k1', chatNode]]) } }, return: null },
  }
  content.appendChild(row)
  seat.appendChild(body)
  flow.appendChild(seat)
  return flow
}

function entryFor(chatNode, options = {}) {
  const t = loadClient().exports.__test
  const doc = new FakeDocument()
  const entries = t.collectPanelEntries(buildFlow(doc, chatNode, options))
  assert.equal(entries.length, 1)
  return entries[0]
}

function assertQuestionEntry(entry) {
  assert.equal(entry.type, 'question')
  assert.ok(entry.text.startsWith(HEADER + '：'), '摘要应以题干开头，实际是：' + entry.text)
  assert.ok(entry.text.endsWith('…'), '超长题干应截断加省略号，实际是：' + entry.text)
  assert.ok(entry.text.indexOf('提问1/1') === -1, '不应退回官方兜底文案：' + entry.text)
  assert.equal(entry.detail, HEADER + '：' + QUESTION)
}

test('已回答的提问：题干从 root.call.argsRaw 读出来', () => {
  assertQuestionEntry(entryFor(answeredNode()))
})

test('还在等待回答的提问：题干从 root.argsRaw 读出来', () => {
  assertQuestionEntry(entryFor(pendingNode()))
})

test('原文缺失时退到流式参数视图：args.value(questions) 也能读到题干', () => {
  assertQuestionEntry(entryFor(argsViewNode()))
})

test('收起的过程组同样能读题干', () => {
  assertQuestionEntry(entryFor(answeredNode(), { hidden: true }))
})

test('界面语言不是中文时按 data-tool 标记认提问行', () => {
  assertQuestionEntry(entryFor(answeredNode(), { rowText: 'Ask question1/1 answered', marker: true }))
})

test('工具组的行不会误判成提问', () => {
  const entry = entryFor(answeredNode(), {
    headerText: '已调用工具',
    rowText: '已读取文件 README.md',
  })
  assert.equal(entry.type, 'tool')
  assert.equal(entry.text, '已读取文件 README.md')
})
