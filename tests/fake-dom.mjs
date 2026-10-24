// 只覆盖本插件用到的那一小撮 DOM：属性选择器、children、rect、textContent。
// 故意不追求通用，够跑扫描/定位/配置开关的回归即可。

function matches(element, selector) {
  // 纯标签选择器（span/button/svg…）：按 tagName 比较，大小写不敏感。
  if (/^[a-zA-Z][\w-]*$/.test(selector)) return String(element.tagName).toLowerCase() === selector.toLowerCase()
  const match = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector)
  if (match === null) throw new Error('fake DOM: unsupported selector ' + selector)
  const name = match[1]
  if (!element.hasAttribute(name)) return false
  return match[2] === undefined || element.getAttribute(name) === match[2]
}

function walk(element, visit) {
  for (const child of element.children) {
    visit(child)
    walk(child, visit)
  }
}

export function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

export class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.children = []
    this.parentNode = null
    this.attrs = new Map()
    this.style = {}
    this.dataset = {}
    this.rect = rect(0, 0, 0, 0)
    this.isConnected = true
    this._className = ''
    this._text = ''
    this.listeners = new Map()
  }

  get id() {
    return this.getAttribute('id') ?? ''
  }

  set id(value) {
    this.setAttribute('id', value)
  }

  get className() {
    return this._className
  }

  set className(value) {
    this._className = String(value)
  }

  appendChild(child) {
    if (child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    child.isConnected = this.isConnected
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index !== -1) this.children.splice(index, 1)
    child.parentNode = null
    child.isConnected = false
  }

  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this)
  }

  contains(other) {
    let node = other
    while (node !== null && node !== undefined) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }

  scrollIntoView(options) {
    this.lastScrollIntoView = options === undefined ? null : options
  }

  setAttribute(name, value) {
    const text = String(value)
    this.attrs.set(name, text)
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null
  }

  hasAttribute(name) {
    return this.attrs.has(name)
  }

  removeAttribute(name) {
    this.attrs.delete(name)
  }

  get textContent() {
    if (this._text !== '') return this._text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }

  getBoundingClientRect() {
    return this.rect
  }

  getClientRects() {
    return this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : []
  }

  closest(selector) {
    let node = this
    while (node !== null) {
      if (matches(node, selector)) return node
      node = node.parentNode
    }
    return null
  }

  querySelectorAll(selector) {
    const found = []
    walk(this, (element) => {
      if (matches(element, selector)) found.push(element)
    })
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  addEventListener(type, listener) {
    let set = this.listeners.get(type)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type, listener) {
    const set = this.listeners.get(type)
    if (set !== undefined) set.delete(listener)
  }

  dispatchEvent(event) {
    const set = this.listeners.get(event.type)
    if (set === undefined) return true
    for (const listener of [...set]) listener(event)
    return true
  }
}

export class FakeDocument {
  constructor() {
    this.root = new FakeElement('root')
    this.head = new FakeElement('head')
    this.body = new FakeElement('body')
    this.root.appendChild(this.head)
    this.root.appendChild(this.body)
    this.documentElement = this.body
  }

  createElement(tagName) {
    return new FakeElement(tagName)
  }

  // SVG 元素的 className 是只读的 SVGAnimatedString，赋值会抛错（真机语义）。
  // 用它抓住「给 SVG 赋 className」这类桩上测不出的错。
  createElementNS(_namespace, tagName) {
    const element = new FakeElement(tagName)
    Object.defineProperty(element, 'className', {
      get() {
        return this.getAttribute('class') ?? ''
      },
      set() {
        throw new TypeError("svg.className is readonly; use setAttribute('class', ...)")
      },
    })
    return element
  }

  getElementById(id) {
    return this.root.querySelectorAll('[id]').find((element) => element.id === id) ?? null
  }

  querySelectorAll(selector) {
    return this.root.querySelectorAll(selector)
  }

  querySelector(selector) {
    return this.root.querySelector(selector)
  }

  addEventListener() {}
  removeEventListener() {}
}

export function makeWindowStub() {
  const listeners = new Map()
  return {
    innerHeight: 900,
    innerWidth: 1200,
    addEventListener(type, listener) {
      let set = listeners.get(type)
      if (set === undefined) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
    },
    removeEventListener(type, listener) {
      const set = listeners.get(type)
      if (set !== undefined) set.delete(listener)
    },
    dispatch(type) {
      const set = listeners.get(type)
      if (set === undefined) return
      for (const listener of [...set]) listener({ type })
    },
    listenerCount(type) {
      const set = listeners.get(type)
      return set === undefined ? 0 : set.size
    },
  }
}
