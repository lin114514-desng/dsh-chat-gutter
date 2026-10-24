// 冷启动契约：客户端插件必须声明「槽位包先就位、自己后激活」，
// 且两处槽位注册要放在 ctx.effect 里（热重载/卸载能收回去，和 dsh-prompt 同形）。
// 依据：2026-10-22 重启日志 dsh-chat-gutter: import failed（同槽位的 dsh-prompt 冷启动正常）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClient } from './harness.mjs'
import { FakeDocument, makeWindowStub } from './fake-dom.mjs'

function readManifest() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
}

/** 记录「注册时是不是正处在某个 ctx.effect 回调里」。 */
function buildCtx(options = {}) {
  const snapshot = {
    status: 'ready',
    value: { enabled: false, showNumbers: true, showBadges: true, answerMark: 'tools' },
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
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }), subscribe: () => () => {} }),
    whileServed: () => () => {},
  }
  const registrations = []
  const effectCalls = []
  const injects = []
  let depth = 0
  const ctx = {
    effect(callback, label) {
      const record = { label: label ?? null, registrationsDuring: 0 }
      effectCalls.push(record)
      depth += 1
      let disposer
      try {
        disposer = callback()
      } finally {
        depth -= 1
      }
      record.registrationsDuring = registrations.length
      return typeof disposer === 'function' ? disposer : () => {}
    },
    slots: {
      inject(name, callback) {
        injects.push(name)
        callback()
        return () => {}
      },
      register(o, component) {
        if (options.failSlot !== undefined && o.name === options.failSlot) {
          throw new Error('list slot "' + o.name + '" boom')
        }
        if (String(o.name).startsWith('conversation.input.') && o.id === undefined) {
          throw new Error('list slot "' + o.name + '" requires options.id')
        }
        registrations.push({ options: o, component, inEffect: depth > 0 })
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
  return { ctx, snapshot, notify, registrations, effectCalls, injects }
}

function setup(options) {
  const doc = new FakeDocument()
  const windowStub = makeWindowStub()
  const { exports } = loadClient({ window: windowStub, document: doc })
  const harness = buildCtx(options)
  return { doc, exports, harness }
}

test('清单声明槽位依赖：dsh.client.inject 里有 ui-conversation 与 ui-slots', () => {
  const manifest = readManifest()
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  const inject = manifest.dsh.client.inject
  assert.ok(Array.isArray(inject), 'dsh.client.inject 必须存在，否则冷启动会先于槽位声明激活插件')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-conversation'), '缺少 ui-conversation: ' + JSON.stringify(inject))
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-slots'), '缺少 ui-slots: ' + JSON.stringify(inject))
})

test('两处槽位注册都跑在 ctx.effect 里：热重载能收回，激活时机由宿主托管', () => {
  const { exports, harness } = setup()
  exports.apply(harness.ctx)

  assert.equal(harness.registrations.length, 2)
  for (const item of harness.registrations) {
    assert.equal(item.inEffect, true, item.options.name + ' 的注册没包在 ctx.effect 里')
  }
  const labels = harness.effectCalls.map((call) => String(call.label ?? ''))
  assert.ok(labels.some((label) => label.includes('config') || label.includes('配置')), '配置页席位应有 effect 标签: ' + JSON.stringify(labels))
  assert.ok(labels.some((label) => label.includes('nav') || label.includes('快速移动')), '快速移动席位应有 effect 标签: ' + JSON.stringify(labels))
})

test('槽位注册抛错时，日志直接留下 name/id/key/order 实参证据', () => {
  const { exports, harness } = setup({ failSlot: 'conversation.input.left' })
  const errors = []
  const original = console.error
  console.error = (...args) => {
    errors.push(args)
  }
  try {
    assert.doesNotThrow(() => exports.apply(harness.ctx))
  } finally {
    console.error = original
  }

  const hit = errors.find((args) =>
    args.some((arg) => arg !== null && typeof arg === 'object' && arg.id === 'dsh-chat-gutter-quick-nav'))
  assert.notEqual(hit, undefined, '没有打出带 id 的注册实参: ' + JSON.stringify(errors.map((args) => String(args[1] ?? args[0]))))
  const payload = hit.find((arg) => arg !== null && typeof arg === 'object' && arg.id !== undefined)
  assert.equal(payload.name, 'conversation.input.left')
  assert.equal(payload.id, 'dsh-chat-gutter-quick-nav')
  assert.equal(payload.key, 'dsh-chat-gutter#quick-nav')
  assert.equal(payload.order, 20)
})
