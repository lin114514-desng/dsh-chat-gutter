// dsh-chat-gutter 浏览器半边
//
// 聊天区两侧空白带 + 输入区一个跳转面板：
//   F1 回合编号路标：#1 #2 …（纯文字），画在内容列右侧，锚定用户自己发的那条消息；
//   F2 过程徽标：按回合合并成一枚 ⚙️工具数 ⌨️命令数 🧐思考数，另加 🤔提问 / 📦上下文压缩；
//   F3 回答段弧线 + ▶答：整段正文左侧花瓣弧线，▶答 钉在弧线真中点；
//   F4 快速移动面板：输入区按钮弹出两列（左列 AI 提问 / 工具 / AI 回答 / 你的消息），
//      点编号直接把聊天区滚动到那一处。
//
// 标记全部画在 body 下的 fixed 覆盖层里（pointer-events:none），左右各一层，
// 并按官方滚动容器用 clip-path 裁到正文可视区；不修改官方 DOM 结构，
// 唯一写进官方行的是自定义属性 data-dsh-answer-start。
//
// 契约：id 必须等于包名 dsh-chat-gutter；只 require baseline 的 react。
window.__ModuleLoader__.load({
  id: 'dsh-chat-gutter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PKG = 'dsh-chat-gutter'
    const LOG = '[dsh-chat-gutter]'
    const STYLE_ID = 'dsh-chat-gutter-style'
    const OVERLAY_ID = 'dsh-chat-gutter'
    const OVERLAY_RIGHT_ID = 'dsh-chat-gutter-right'
    const ANSWER_ATTR = 'data-dsh-answer-start'

    const GUTTER_WIDTH = 92
    const GUTTER_GAP = 8
    const GUTTER_MARGIN = 4
    const MARKER_GAP = 18
    const MARKER_EDGE = 10
    // 每条覆盖层上一次写进去的 clip-path：浏览器会把第四个值归一化，不能拿读回值当缓存。
    const overlayClips = new WeakMap()
    const FLOW_MAX_HEIGHT = 96
    // 结构检查的最小间隔：流式吐字期间最多 6 次/秒。
    // 每次检查只算结构指纹，指纹没变就走只量坐标的快路。
    const SCAN_INTERVAL = 180

    const DEFAULT_CONFIG = Object.freeze({
      enabled: true,
      showNumbers: true,
      showBadges: true,
      answerMark: 'tools',
    })
    const ANSWER_MODES = ['off', 'tools', 'always']
    const WORK_KINDS = new Set(['tool-call', 'tool-result', 'command', 'compaction'])
    const ANSWER_KINDS = new Set(['assistant-step', 'assistant'])
    const BADGE_TEXT = {
      'tool-call': '⚙️工具',
      'tool-result': '⚙️工具',
      command: '⌨️命令',
      reasoning: '🧐思考',
      compaction: '📦上下文压缩',
    }

    // ================================================================
    // 纯逻辑（测试从 __test 直接调用）
    // ================================================================

    /** 配置值可能被包成 volatile ref，逐层 .get() 解到普通值。 */
    function unwrap(value) {
      let current = value
      for (let i = 0; i < 3; i++) {
        if (current === null || typeof current !== 'object' || typeof current.get !== 'function') break
        try {
          current = current.get()
        } catch {
          break
        }
      }
      return current
    }

    function normalizeConfig(input) {
      const raw = unwrap(input)
      const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      const bool = (key) => {
        const value = unwrap(source[key])
        return typeof value === 'boolean' ? value : DEFAULT_CONFIG[key]
      }
      const mode = unwrap(source.answerMark)
      return {
        enabled: bool('enabled'),
        showNumbers: bool('showNumbers'),
        showBadges: bool('showBadges'),
        answerMark: typeof mode === 'string' && ANSWER_MODES.indexOf(mode) !== -1 ? mode : DEFAULT_CONFIG.answerMark,
      }
    }

    function sameConfig(a, b) {
      return a.enabled === b.enabled &&
        a.showNumbers === b.showNumbers &&
        a.showBadges === b.showBadges &&
        a.answerMark === b.answerMark
    }

    function badgeForKind(kind) {
      return Object.prototype.hasOwnProperty.call(BADGE_TEXT, kind) ? BADGE_TEXT[kind] : null
    }

    function isAnswerRow(row) {
      if (row === null || typeof row !== 'object') return false
      if (row.visible === false) return false
      if (row.hasText === false) return false
      if (row.groupPart === 'reasoning') return false
      return ANSWER_KINDS.has(row.kind)
    }

    function isWorkRow(row) {
      if (row === null || typeof row !== 'object') return false
      if (row.questionReply === true) return true
      return WORK_KINDS.has(row.kind)
    }

    /**
     * 每回合挑出要高亮的正文行键。
     * off：空；always：每回合第一段可见正文；tools：每回合最后一个干活行之后的第一段可见正文。
     */
    function planAnswerMarks(rows, mode) {
      const result = []
      if (!Array.isArray(rows) || rows.length === 0) return result
      if (mode !== 'tools' && mode !== 'always') return result

      const byTurn = new Map()
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        const turn = row.turn === undefined || row.turn === null ? '' : String(row.turn)
        let bucket = byTurn.get(turn)
        if (bucket === undefined) {
          bucket = []
          byTurn.set(turn, bucket)
        }
        bucket.push(row)
      }

      for (const bucket of byTurn.values()) {
        let startIndex = -1
        if (mode === 'always') {
          for (let i = 0; i < bucket.length; i++) {
            if (isAnswerRow(bucket[i])) {
              startIndex = i
              break
            }
          }
        } else {
          let lastWork = -1
          for (let i = 0; i < bucket.length; i++) {
            if (isWorkRow(bucket[i])) lastWork = i
          }
          if (lastWork === -1) continue
          for (let i = lastWork + 1; i < bucket.length; i++) {
            if (isAnswerRow(bucket[i])) {
              startIndex = i
              break
            }
          }
        }
        if (startIndex === -1) continue
        // 整段标记：从起点起连续的正文行都入列；遇工作行/非正文断开。
        for (let i = startIndex; i < bucket.length; i++) {
          const row = bucket[i]
          if (!isAnswerRow(row)) break
          result.push(row.key)
        }
      }
      return result
    }

    /** 按 top 排序后强制最小间距，避免相邻徽标叠字。 */
    function layoutMarkers(items, gap) {
      const list = []
      for (const item of Array.isArray(items) ? items : []) {
        if (item === null || typeof item !== 'object') continue
        if (typeof item.top !== 'number' || !Number.isFinite(item.top)) continue
        list.push(item)
      }
      list.sort((a, b) => a.top - b.top)
      const placed = []
      let previous = null
      for (const item of list) {
        let top = item.top
        if (previous !== null && top < previous + gap) top = previous + gap
        previous = top
        placed.push({ ...item, top })
      }
      return placed
    }

    /** 左侧空白带是否放得下：返回覆盖层 left，放不下返回 null。 */
    function gutterLeft(flowLeft, width, gap, margin) {
      if (typeof flowLeft !== 'number' || !Number.isFinite(flowLeft)) return null
      const left = flowLeft - width - gap
      return left >= margin ? left : null
    }

    /** 右侧空白带是否放得下：返回覆盖层 left，放不下返回 null。 */
    function gutterRight(contentLeft, contentWidth, width, gap, margin, viewportWidth) {
      if (typeof contentLeft !== 'number' || !Number.isFinite(contentLeft)) return null
      if (typeof contentWidth !== 'number' || !Number.isFinite(contentWidth) || contentWidth <= 0) return null
      if (typeof viewportWidth !== 'number' || !Number.isFinite(viewportWidth) || viewportWidth <= 0) return null
      const left = contentLeft + contentWidth + gap
      return viewportWidth - margin - left >= width ? left : null
    }

    /** 编号锚点优先级：用户自己发的行排在前面，其余退后。 */
    function userRank(kind) {
      if (kind === 'user') return 0
      if (kind === 'steering') return 1
      if (kind === 'turn-trigger') return 2
      return 3
    }

    /** 过程徽标文案：⚙️工具数 ⌨️命令数 🧐思考数；没有的类不写，全无则不出徽标。 */
    function processBadgeText(tools, commands, thoughts) {
      const parts = []
      if (tools > 0) parts.push('⚙️' + tools)
      if (commands > 0) parts.push('⌨️' + commands)
      if (thoughts > 0) parts.push('🧐' + thoughts)
      return parts.length === 0 ? null : parts.join(' ')
    }

    /** 过程组里的工具类行数（调用/结果/命令/压缩都算干活的次数）。 */
    function countTools(kinds) {
      let count = 0
      for (const kind of kinds) {
        if (kind === 'tool-call' || kind === 'tool-result' || kind === 'command' || kind === 'compaction') count += 1
      }
      return count
    }

    /** 思考计数：reasoning 行 + 行内 think 块都算。 */
    function countThinkRows(rows, thinkBlockCount) {
      let count = 0
      for (const row of rows) if (row.kind === 'reasoning') count += 1
      return count + thinkBlockCount
    }

    // ================================================================
    // 快速移动面板：纯逻辑（测试从 __test 直接调用）
    // ================================================================

    /** 面板四类，左列按这个顺序排。 */
    const PANEL_CATEGORIES = [
      { type: 'question', icon: '🤔', label: 'AI 提问' },
      { type: 'tool', icon: '⚙️', label: '工具' },
      { type: 'answer', icon: '▶️', label: 'AI 回答' },
      { type: 'ask', icon: '💬', label: '你的消息' },
    ]
    // 右列每行摘要的字数：再多就把列撑开了。
    const PANEL_ENTRY_TEXT = 20

    /** 聊天行类型 → 面板分类；认不出的（回合汇总条、动作条等）不进面板。 */
    function panelTypeOfKind(kind) {
      if (kind === 'user' || kind === 'steering' || kind === 'turn-trigger') return 'ask'
      if (kind === 'tool-call' || kind === 'tool-result' || kind === 'command' || kind === 'compaction') return 'tool'
      if (kind === 'assistant-step' || kind === 'assistant') return 'answer'
      return null
    }

    /**
     * 过程小结行（data-step-process）按文案分两类。
     * 官方文案 message.stepProcess.done.questions ＝「向用户提出了问题」，其余（已调用工具/已读取文件…）算工具。
     */
    function questionSeatType(text) {
      const flat = String(text === null || text === undefined ? '' : text)
      if (flat.indexOf('向用户提出了问题') !== -1) return 'question'
      if (/ask_user_question/i.test(flat)) return 'question'
      return 'tool'
    }

    /** 摘要：压掉换行与多余空白，超长按字符截断加省略号（不切坏 emoji）。 */
    function excerptText(text, max) {
      const flat = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim()
      if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return flat
      const chars = Array.from(flat)
      if (chars.length <= max) return flat
      return chars.slice(0, max).join('') + '…'
    }

    /** 连续的回答行算一段回答：编号按段算，只留每段第一行当锚点。 */
    function mergeAnswerRuns(items) {
      const merged = []
      for (const item of Array.isArray(items) ? items : []) {
        if (item === null || typeof item !== 'object') continue
        const last = merged.length > 0 ? merged[merged.length - 1] : null
        if (last !== null && last.type === 'answer' && item.type === 'answer') continue
        merged.push(item)
      }
      return merged
    }

    function summaryText(config) {
      if (!config.enabled) return '已关闭'
      const bits = []
      if (config.showNumbers) bits.push('编号')
      if (config.showBadges) bits.push('徽标')
      bits.push(config.answerMark === 'off' ? '回答高亮关' : config.answerMark === 'always' ? '回答高亮总是' : '回答高亮干完活后')
      return bits.join(' · ')
    }

    // ================================================================
    // 样式与覆盖层
    // ================================================================

    // 字号与行高都挂 DSH 自己的字号变量：界面字号调大，带子跟着大。
    const CSS = `
#dsh-chat-gutter,#dsh-chat-gutter-right{position:fixed;top:0;left:0;width:${GUTTER_WIDTH}px;height:100vh;z-index:30;
  pointer-events:none;display:none;
  font-family:Inter,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);
  -webkit-font-smoothing:antialiased;
  color:var(--dsw-alias-label-secondary,#6b7280)}
#dsh-chat-gutter .dcg-rail,#dsh-chat-gutter-right .dcg-rail{position:absolute;width:1px;height:0;display:none;
  background:var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:1px}
#dsh-chat-gutter .dcg-rail{right:4px}
#dsh-chat-gutter-right .dcg-rail{left:4px}
#dsh-chat-gutter .dcg-marker,#dsh-chat-gutter-right .dcg-marker{position:absolute;white-space:nowrap;box-sizing:border-box}
#dsh-chat-gutter .dcg-marker{right:0}
#dsh-chat-gutter-right .dcg-marker{left:0}
#dsh-chat-gutter .dcg-num,#dsh-chat-gutter-right .dcg-num{width:100%;
  font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));
  font-variant-numeric:tabular-nums;letter-spacing:.02em;
  color:var(--dsw-alias-label-secondary,#6b7280)}
#dsh-chat-gutter .dcg-num{padding-right:14px;text-align:right}
#dsh-chat-gutter-right .dcg-num{padding-left:14px;text-align:left}
#dsh-chat-gutter .dcg-num::after,#dsh-chat-gutter-right .dcg-num::after{content:'';position:absolute;top:50%;
  margin-top:-3px;width:6px;height:6px;border-radius:50%;
  background:var(--dsw-alias-label-tertiary,#8b93a1)}
#dsh-chat-gutter .dcg-num::after{right:1px}
#dsh-chat-gutter-right .dcg-num::after{left:1px}
#dsh-chat-gutter .dcg-badge{right:6px;max-width:86px;padding:1px 4px;border-radius:5px;
  font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);
  line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));
  color:var(--dsw-alias-label-secondary,#6b7280);
  background:rgba(127,127,127,.12);
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));
  /* top 写的是锚点行的可视中线，靠这一行把自己垂直居中，字号变化也不歪。 */
  transform:translateY(-50%);
  overflow:hidden;text-overflow:ellipsis}
#dsh-chat-gutter .dcg-answer{color:var(--dsw-alias-label-primary,#1f2328);
  background:rgba(59,130,246,.16);
  border-color:rgba(59,130,246,.55)}
/* 回答段整段弧线：左带里的 SVG 花瓣填充形 —— 中段最厚、上下两端收成尖，
   外缘向左深鼓；55% 透明度；随滚动实时重算。 */
#dsh-chat-gutter .dcg-answer-arc{position:absolute;right:4px;display:none;pointer-events:none;overflow:visible}
#dsh-chat-gutter .dcg-answer-arc path{fill:var(--dsw-specific-accent,#3b82f6);opacity:.55;stroke:none}
/* vertical-align:middle 兜底：插槽容器若是按文字基线排版，按钮会被行高顶下去一点。 */
.dcg-nav{position:relative;display:inline-flex;align-items:center;vertical-align:middle}
.dcg-nav-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-primary);cursor:pointer;
  font-family:Inter,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);
  font-size:12px;font-weight:500;white-space:nowrap;-webkit-font-smoothing:antialiased}
.dcg-nav-btn:hover{color:var(--dsw-specific-accent,#f0a45c)}
/* 两列面板：左列分类（带条数），右列编号 + 摘要；贴着按钮往上弹。 */
.dcg-panel{position:fixed;right:16px;bottom:96px;z-index:9999;display:none;flex-direction:column;
  width:340px;max-height:320px;
  border-radius:10px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1,var(--dsw-specific-menu));box-shadow:var(--dsw-shadow-lv3);
  overflow:hidden;box-sizing:border-box;
  font-family:Inter,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);
  font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);
  color:var(--dsw-alias-label-primary)}
/* 面板本体：左列分类 + 右列条目横排；底部那条「加载更早」单独占一行。 */
.dcg-panel-body{display:flex;flex-direction:row;flex:1 1 auto;min-height:0}
.dcg-panel-cats{display:flex;flex-direction:column;gap:2px;padding:6px;width:118px;flex:0 0 118px;
  box-sizing:border-box;border-right:1px solid var(--dsw-alias-border-l1)}
.dcg-cat{display:flex;align-items:center;padding:6px 8px;border:0;border-radius:7px;
  background:transparent;color:inherit;cursor:pointer;text-align:left;
  font-family:inherit;font-size:inherit;line-height:1.4;white-space:nowrap}
.dcg-cat:hover{background:var(--dsw-alias-bg-layer-3)}
.dcg-cat[data-active="1"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-specific-accent,#f0a45c)}
.dcg-cat[data-empty="1"]{opacity:.4}
.dcg-panel-entries{display:flex;flex-direction:column;gap:2px;padding:6px;flex:1 1 auto;
  min-width:0;overflow-y:auto;overscroll-behavior:contain}
/* 条目行不许被压缩：竖向 flex 容器默认会把超出的行挤扁，挤扁后内容不溢出，滚动条就不出现，
   表现成「条目多了最后几条被切掉」。行保持自身高度，交给容器滚动。 */
.dcg-entry{display:block;width:100%;box-sizing:border-box;padding:6px 8px;border:0;border-radius:7px;
  background:transparent;color:inherit;cursor:pointer;text-align:left;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;flex:0 0 auto;
  font-family:inherit;font-size:inherit;line-height:1.4}
.dcg-entry:hover{background:var(--dsw-alias-bg-layer-3)}
.dcg-panel-empty{padding:8px;opacity:.6;white-space:nowrap;flex:0 0 auto}
/* 底部通栏：只有官方聊天区确实还有更早的历史时才出现（JS 控制 display）。 */
.dcg-panel-more{display:none;flex:0 0 auto;width:100%;box-sizing:border-box;padding:7px 8px;
  border:0;border-top:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;text-align:center;
  font-family:inherit;font-size:inherit;line-height:1.4}
.dcg-panel-more:hover{background:var(--dsw-alias-bg-layer-3)}
.dcg-panel-more:disabled{opacity:.55;cursor:default;background:transparent}
`

    const state = {
      cfg: { ...DEFAULT_CONFIG },
      engineOn: false,
      styleEl: null,
      overlay: null,
      rail: null,
      overlayRight: null,
      railRight: null,
      markers: new Map(),
      answerEls: new Set(),
      answerLines: [],
      answerSegments: [],
      scrollRaf: null,
      flowEl: null,
      scrollEl: null,
      flowObserver: null,
      bodyObserver: null,
      scanTimer: null,
      scanRaf: null,
      lastScanAt: 0,
      structureSignature: null,
      scanFull: 0,
      scanCheap: 0,
      positionRaf: null,
      retryTimer: null,
      form: null,
      formUnsub: null,
      formWaitTried: false,
      formWaitDispose: null,
      debugLogged: false,
      disposed: false,
      onScroll: null,
      onResize: null,
      navPanel: null,
      navUnbind: null,
    }

    function ensureStyles() {
      // 热替换时上一版的 <style> 会留在页面上：认领它之后必须把内容换成当前版本，
      // 否则新加的规则（比如面板那几条）永远进不了页面。
      if (state.styleEl !== null && state.styleEl.isConnected !== false) {
        if (state.styleEl.textContent !== CSS) state.styleEl.textContent = CSS
        return
      }
      if (typeof document === 'undefined' || !document.head) return
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) {
        if (existing.textContent !== CSS) existing.textContent = CSS
        state.styleEl = existing
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      state.styleEl = style
    }

    function removeStyles() {
      if (state.styleEl !== null && typeof state.styleEl.remove === 'function') state.styleEl.remove()
      else if (typeof document !== 'undefined' && document.getElementById) {
        const existing = document.getElementById(STYLE_ID)
        if (existing !== null && typeof existing.remove === 'function') existing.remove()
      }
      state.styleEl = null
    }

    function adoptBand(id) {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null
      const existing = document.getElementById(id)
      if (existing === null || existing === undefined) return null
      let rail = null
      const kids = existing.children
      if (kids !== null && kids !== undefined) {
        for (const child of kids) {
          if (child !== null && child !== undefined && child.className === 'dcg-rail') {
            rail = child
            break
          }
        }
      }
      if (rail === null) {
        rail = document.createElement('div')
        rail.className = 'dcg-rail'
        existing.appendChild(rail)
      }
      return { overlay: existing, rail }
    }

    function createBand(id) {
      const overlay = document.createElement('div')
      overlay.id = id
      overlay.setAttribute('aria-hidden', 'true')
      const rail = document.createElement('div')
      rail.className = 'dcg-rail'
      overlay.appendChild(rail)
      document.body.appendChild(overlay)
      return { overlay, rail }
    }

    function ensureBand(id, overlay, rail) {
      if (overlay !== null && overlay !== undefined && overlay.isConnected !== false) return { overlay, rail }
      const adopted = adoptBand(id)
      return adopted !== null ? adopted : createBand(id)
    }

    function ensureOverlay() {
      if (typeof document === 'undefined' || !document.body) return
      const left = ensureBand(OVERLAY_ID, state.overlay, state.rail)
      state.overlay = left.overlay
      state.rail = left.rail
      const right = ensureBand(OVERLAY_RIGHT_ID, state.overlayRight, state.railRight)
      state.overlayRight = right.overlay
      state.railRight = right.rail
    }

    function removeOverlay() {
      for (const overlay of [state.overlay, state.overlayRight]) {
        if (overlay !== null && typeof overlay.remove === 'function') overlay.remove()
      }
      state.overlay = null
      state.rail = null
      state.overlayRight = null
      state.railRight = null
      state.markers.clear()
    }

    // ================================================================
    // DOM 读取 helpers
    // ================================================================

    function isHidden(element) {
      if (!element || element.isConnected === false) return true
      if (typeof element.closest === 'function' && element.closest('[hidden]') !== null) return true
      if (element.dataset && element.dataset.chatMotion === 'collapse') return true
      return false
    }

    function safeRect(element) {
      try {
        return element.getBoundingClientRect()
      } catch {
        return null
      }
    }

    function isOnScreen(rect, viewportHeight) {
      if (!rect || rect.width <= 0 || rect.height <= 0) return false
      return rect.bottom > 0 && rect.top < viewportHeight
    }

    function rowHasText(element) {
      try {
        return String(element.textContent || '').trim() !== ''
      } catch {
        return false
      }
    }

    /**
     * 内容列的左界与宽度。
     * 聊天流容器在真实页面里是 display:contents：自身不生成盒子，getBoundingClientRect()
     * 恒为 0×0。所以依次退到父元素（内容列）和真实聊天行，谁量得准就用谁。
     * @returns {{left:number,width:number}|null} 都量不出来时返回 null
     */
    function measureContent(flow) {
      if (flow === null || flow === undefined) return null
      const own = safeRect(flow)
      if (own !== null && own.width > 0) return { left: own.left, width: own.width }
      const parent = flow.parentNode
      if (parent && typeof parent.getBoundingClientRect === 'function') {
        const outer = safeRect(parent)
        if (outer !== null && outer.width > 0) return { left: outer.left, width: outer.width }
      }
      if (typeof flow.querySelectorAll !== 'function') return null
      let best = null
      for (const row of flow.querySelectorAll('[data-chat-flow-key]')) {
        if (isHidden(row)) continue
        const rect = safeRect(row)
        if (rect === null || rect.width <= 0) continue
        if (best === null || rect.left < best.left) best = { left: rect.left, width: rect.width }
      }
      return best
    }

    /**
     * 内容列的右边界：取真实聊天行的最右边缘（文字停在哪，带子就贴到哪），
     * 量不到再退回容器 / 父列的盒子。
     * @returns {number|null} 量不出来返回 null
     */
    function measureContentRight(flow) {
      let best = null
      if (flow !== null && flow !== undefined && typeof flow.querySelectorAll === 'function') {
        for (const row of flow.querySelectorAll('[data-chat-flow-key]')) {
          if (isHidden(row)) continue
          const rect = safeRect(row)
          if (rect === null || rect.width <= 0) continue
          const right = rect.left + rect.width
          if (best === null || right > best) best = right
        }
      }
      if (best !== null) return best
      const content = measureContent(flow)
      return content === null ? null : content.left + content.width
    }

    function viewportWidth() {
      if (typeof window !== 'undefined' && window !== null && Number.isFinite(window.innerWidth)) return window.innerWidth
      if (typeof document !== 'undefined' && document !== null) {
        const root = document.documentElement
        if (root !== null && root !== undefined && Number.isFinite(root.clientWidth)) return root.clientWidth
      }
      return 1200
    }

    function findFlow() {
      if (typeof document === 'undefined' || !document.querySelectorAll) return null
      const nodes = document.querySelectorAll('[data-slot="conversation.chat.flow"]')
      let fallback = null
      for (const node of nodes) {
        if (isHidden(node)) continue
        if (measureContent(node) !== null) return node
        if (fallback === null) fallback = node
      }
      return fallback
    }

    function collectRows(flow) {
      const rows = []
      if (flow === null || typeof flow.querySelectorAll !== 'function') return rows
      const nodes = flow.querySelectorAll('[data-chat-flow-key]')
      for (const element of nodes) {
        const kind = element.getAttribute('data-chat-flow-kind')
        if (kind === null) continue
        // turn-process 保留：它是回合汇总条（收起后唯一的活证据），只不再当普通行用。
        if (element.hasAttribute('data-chat-group-key')) continue
        const key = element.getAttribute('data-chat-flow-key')
        if (key === null || key === '') continue
        rows.push({
          el: element,
          key,
          kind,
          groupPart: element.getAttribute('data-chat-group-part') || undefined,
          turn: element.getAttribute('data-chat-turn') || '',
          visible: !isHidden(element),
          hasText: rowHasText(element),
          questionReply: typeof element.querySelector === 'function' && element.querySelector('[data-question-reply]') !== null,
        })
      }
      return rows
    }

    // ================================================================
    // 标记计划
    // ================================================================

    function numberMarkers(rows) {
      const turns = new Map()
      for (const row of rows) {
        if (!row.visible || row.turn === '') continue
        let bucket = turns.get(row.turn)
        if (bucket === undefined) {
          bucket = []
          turns.set(row.turn, bucket)
        }
        bucket.push({ rank: userRank(row.kind), el: row.el })
      }
      const markers = []
      let index = 0
      for (const [turn, bucket] of turns) {
        // 用户自己发的那条排在锚点最前，编号就落在提问行上。
        const anchors = bucket.slice().sort((a, b) => a.rank - b.rank).map((item) => item.el)
        index += 1
        const label = /^\d+$/.test(turn) ? turn : String(index)
        markers.push({
          key: 'turn:' + turn,
          kind: 'num',
          text: '#' + label,
          anchors,
        })
      }
      return markers
    }

    /**
     * 过程徽标合并：不再逐行画 ⚙️/🧐，按回合聚成一个徽标。
     * 锚点首选官方回合汇总条 [data-turn-process]（收起后仍在，就是「已完成，用时 …」那条），
     * 没有再找过程组头 [data-step-process]，最后退回回合第一个工具行。
     */
    function processBadgeMarkers(flow, rows) {
      const markers = []
      const byTurn = new Map()
      for (const row of rows) {
        // 收起的行也计入：折叠后过程组的活儿仍要反映在徽标里。
        let bucket = byTurn.get(row.turn)
        if (bucket === undefined) {
          bucket = { rows: [], firstTool: null, summary: null, officialTools: null }
          byTurn.set(row.turn, bucket)
        }
        bucket.rows.push(row)
        if (row.kind === 'turn-process') {
          // 官方在汇总条上写好的计数：data-turn-process-tool-calls 收起后也准。
          const raw = row.el.getAttribute('data-turn-process-tool-calls')
          const parsed = raw === null ? NaN : Number(raw)
          if (Number.isFinite(parsed)) bucket.officialTools = parsed
          bucket.summary = row.el
          continue
        }
        const isTool = row.kind === 'tool-call' || row.kind === 'tool-result' || row.kind === 'command' || row.kind === 'compaction'
        if (isTool && bucket.firstTool === null && row.visible) bucket.firstTool = row.el
      }
      // think 块按它所属行的 turn 归组（收起的块也计入）。
      const thinkByTurn = new Map()
      if (flow !== null && typeof flow.querySelectorAll === 'function') {
        for (const block of flow.querySelectorAll('[data-variant="think"]')) {
          const owner = typeof block.closest === 'function' ? block.closest('[data-chat-flow-key]') : null
          const turn = owner !== null ? String(owner.getAttribute('data-chat-turn') || '') : ''
          thinkByTurn.set(turn, (thinkByTurn.get(turn) || 0) + 1)
        }
      }
      for (const [turn, bucket] of byTurn) {
        const kinds = bucket.rows.map((row) => row.kind).filter((kind) => kind !== 'turn-process')
        const tools = bucket.officialTools !== null ? bucket.officialTools : countTools(kinds.filter((kind) => kind !== 'command'))
        const commands = countTools(kinds.filter((kind) => kind === 'command'))
        const thoughts = countThinkRows(bucket.rows, thinkByTurn.get(turn) || 0)
        const text = processBadgeText(tools, commands, thoughts)
        if (text === null) continue
        const anchor = bucket.summary !== null ? bucket.summary : processAnchor(flow, turn, bucket.firstTool)
        if (anchor === null) continue
        markers.push({ key: 'process:' + turn, kind: 'badge', text, anchors: [anchor] })
      }
      return markers
    }

    /** 过程徽标的兜底锚点：「已调用工具…」组头部行，再退回回合第一个工具行。 */
    function processAnchor(flow, turn, fallback) {
      if (flow === null || typeof flow.querySelectorAll !== 'function') return fallback
      let best = null
      for (const group of flow.querySelectorAll('[data-step-process]')) {
        if (isHidden(group)) continue
        if (String(group.getAttribute('data-chat-turn') || '') !== turn) continue
        // 组根元素太高，锚到第一个子元素（标题行）。
        best = group.children && group.children.length > 0 ? group.children[0] : group
        break
      }
      return best !== null ? best : fallback
    }

    // ================================================================
    // 快速移动：输入区按钮 + 两列跳转面板
    // ================================================================

    const NAV_ID = 'dsh-chat-gutter-nav'
    const PANEL_ID = 'dsh-chat-gutter-panel'
    // 面板宽度写死：位置要按它夹进窗口，量元素宽度在多显示器缩放下不可靠。
    const PANEL_WIDTH = 340
    // 跳过去后目标行离正文可视区上沿留多高，留一点上下文。
    const PANEL_TOP_PAD = 96
    // 每次热替换模块都会重新求值：用它在 DOM 上认出哪些节点是本实例建的。
    const INSTANCE = Math.random().toString(36).slice(2) + '-' + String(Date.now())

    /**
     * 收集面板条目：四类目标按文档顺序排好，连续的回答行合并成一段。
     * 过程小结行（data-step-process）代表它自己那一组，组内的行列过后不再重复出现。
     */
    /**
     * 过程组条目的摘要：跳过组头那句「已调用工具、已读取文件…」，用组里第一行的正文。
     * 组头是分类用的固定文案，每组都长一个样，当摘要等于没标；真正有用的是
     * 「读取了哪个文件、跑了什么命令、问了什么」。
     */
    function seatContentText(seat) {
      if (seat === null || seat === undefined) return ''
      let body = null
      try {
        body = typeof seat.querySelector === 'function' ? seat.querySelector('[data-step-process-body]') : null
      } catch {
        body = null
      }
      if (body !== null && body !== undefined) {
        let content = null
        try {
          content = typeof body.querySelector === 'function' ? body.querySelector('[data-step-process-content]') : null
        } catch {
          content = null
        }
        const box = content !== null && content !== undefined ? content : body
        const rows = box === null || box === undefined ? undefined : box.children
        const first = rows !== undefined && rows !== null && rows.length > 0 ? rows[0] : box
        const text = String(first === null || first === undefined ? '' : first.textContent || '').replace(/\s+/g, ' ').trim()
        if (text !== '') return text
      }
      return String(seat.textContent || '')
    }

    /**
     * 条目摘要：路径类文本取末尾（同一个目录下只差文件名的两条，看开头分不清），
     * 其余取开头。截断都按字符切，不切坏 emoji。
     */
    function excerptEntry(text, max) {
      const flat = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim()
      const chars = Array.from(flat)
      if (chars.length <= max) return flat
      const separators = (flat.match(/[\\/]/g) || []).length
      if (separators >= 3) return '…' + chars.slice(chars.length - (max - 1)).join('')
      return chars.slice(0, max).join('') + '…'
    }

    /** 过程组的组头元素：官方把「已调用工具／向用户提出了问题」这类分类文案写在这里。 */
    function seatHeader(seat) {
      if (seat === null || seat === undefined) return null
      const children = seat.children
      if (children === undefined || children === null || children.length === 0) return null
      return children[0]
    }

    /**
     * 过程组归类只看组头，不看组内容。
     * 组里的思考文本常提到 ask_user_question 这类工具名，按整组文本判会把工具组误判成提问。
     */
    function seatType(seat) {
      const header = seatHeader(seat)
      return questionSeatType(header !== null && header !== undefined ? header.textContent : seat.textContent)
    }

    /**
     * 官方「加载更早」按钮的文案：跟着界面语言走，加载中还会换成「加载中…」。
     * 只用来兜底，主判据是它在页面上的位置。
     */
    const LOAD_EARLIER_LABELS = ['加载更早', '加载中', 'load earlier', 'loading']

    function isLoadEarlierLabel(text) {
      const flat = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase()
      if (flat === '') return false
      for (const label of LOAD_EARLIER_LABELS) {
        if (flat.indexOf(label) !== -1) return true
      }
      return false
    }

    /** 按钮是不是禁用了：属性与属性对象两种写法都认（真机由 React 写属性）。 */
    function isDisabledButton(button) {
      if (button === null || button === undefined) return false
      if (button.disabled === true) return true
      return typeof button.hasAttribute === 'function' && button.hasAttribute('disabled')
    }

    /** 聊天流所在的那一列：官方给它挂了 data-chat-flow，认不出就退回父节点。 */
    function flowColumn(flow) {
      if (flow === null || flow === undefined) return null
      try {
        if (typeof flow.closest === 'function') {
          const column = flow.closest('[data-chat-flow]')
          if (column !== null && column !== undefined && column !== flow) return column
        }
      } catch {
        // 认不出列就当没有
      }
      return flow.parentNode !== null && flow.parentNode !== undefined ? flow.parentNode : null
    }

    /** 按钮是不是排在聊天流之前：官方把入口放在列顶、聊天流之前。 */
    function isBeforeFlow(button, flow, column) {
      const children = column !== null && column !== undefined && column.children !== undefined ? column.children : null
      if (children === null || typeof children.length !== 'number') return false
      for (const child of children) {
        // 聊天流藏在更深一层时，位置判不了，交给文案与类名。
        if (child === flow) return false
        if (typeof child.contains === 'function' && child.contains(flow)) return false
        if (child === button) return true
        if (typeof child.contains === 'function' && child.contains(button)) return true
      }
      return false
    }

    /** 按钮是不是装在类名带 older 的那层壳里（官方 xz4KEq_older，hash 会变、older 留着）。 */
    function inOlderBox(button, column) {
      let node = button
      for (let depth = 0; depth < 6; depth++) {
        const parent = node === null || node === undefined ? null : node.parentNode
        if (parent === null || parent === undefined || parent === column) return false
        const name = typeof parent.className === 'string' ? parent.className : ''
        if (name !== '' && /older/i.test(name)) return true
        node = parent
      }
      return false
    }

    /**
     * 找回官方那个「加载更早」按钮：点它等于用户自己点。
     * 只统计已加载进页面的内容就是面板的天花板——更早的轮次还没拉进 DOM，面板里根本没有。
     * 判据顺序：聊天流之前、同一列里、不在聊天流内部的 button → 文案 → 外层类名 older；
     * 一列里出现多个都说不清的按钮时宁可不给入口，也不去点别的按钮。
     */
    function findLoadEarlier(flow) {
      if (flow === null || flow === undefined) return null
      const column = flowColumn(flow)
      if (column === null || typeof column.querySelectorAll !== 'function') return null
      let nodes = []
      try {
        nodes = column.querySelectorAll('button')
      } catch {
        return null
      }
      const buttons = []
      for (const button of nodes) {
        if (button === flow) continue
        if (typeof flow.contains === 'function' && flow.contains(button)) continue
        buttons.push(button)
      }
      if (buttons.length === 0) return null
      const before = buttons.filter((button) => isBeforeFlow(button, flow, column))
      const pool = before.length > 0 ? before : buttons
      for (const button of pool) {
        if (isLoadEarlierLabel(button.textContent)) return button
      }
      for (const button of pool) {
        if (inOlderBox(button, column)) return button
      }
      // 位置判据成立、这一列里就只有这一个按钮：官方的入口就是它。
      if (before.length === 1) return pool[0]
      return null
    }

    /** 从一份组件属性里挑题干：官方把每个提问做成 { header, question, options } 这种对象。 */
    function questionTextOf(value) {
      if (value === null || value === undefined || typeof value !== 'object') return null
      const raw = typeof value.question === 'string' ? value.question : (typeof value.questionText === 'string' ? value.questionText : null)
      if (raw === null || raw.trim() === '') return null
      const text = raw.trim()
      const header = typeof value.header === 'string' ? value.header.trim() : ''
      return header !== '' && header !== text ? header + '：' + text : text
    }

    /** 在属性树里搜题干：深度与命中数都封顶，React 的 children 子树不进去。 */
    function collectQuestionTexts(value, depth, out, seen) {
      if (value === null || value === undefined) return
      if (depth > 6 || out.length >= 4) return
      // 工具入参常常是一段 JSON 字符串，题干就藏在里面。
      if (typeof value === 'string') {
        const flat = value.trim()
        if (flat.length < 8 || flat.length > 20000) return
        const head = flat.charCodeAt(0)
        if (head !== 123 && head !== 91) return // '{' 或 '['
        let parsed = null
        try {
          parsed = JSON.parse(flat)
        } catch {
          return
        }
        collectQuestionTexts(parsed, depth + 1, out, seen)
        return
      }
      if (typeof value !== 'object') return
      if (seen.has(value)) return
      seen.add(value)
      if (Array.isArray(value)) {
        for (const item of value) collectQuestionTexts(item, depth + 1, out, seen)
        return
      }
      const text = questionTextOf(value)
      if (text !== null) {
        if (out.indexOf(text) === -1) out.push(text)
        return
      }
      for (const name of Object.keys(value)) {
        // children 是 React 的整棵子节点树，进去只会绕圈子。
        if (name === 'children') continue
        collectQuestionTexts(value[name], depth + 1, out, seen)
      }
    }

    /** 从节点的 React 句柄顺着 return 链找节点仓库（官方把会话节点都存在这一处）。 */
    function nodeStoreOf(node) {
      let fiber = null
      try {
        for (const name of Object.keys(node)) {
          if (name.indexOf('__reactFiber$') === 0 || name.indexOf('__reactInternalInstance$') === 0) {
            fiber = node[name]
            break
          }
        }
      } catch {
        return null
      }
      if (fiber === null || fiber === undefined) return null
      let cursor = fiber
      for (let depth = 0; depth < 10 && cursor !== null && cursor !== undefined; depth++) {
        let props = null
        try {
          props = cursor.memoizedProps
        } catch {
          props = null
        }
        if (props !== null && props !== undefined && typeof props === 'object') {
          const store = props.nodeStore
          if (store !== null && store !== undefined && typeof store === 'object' && store.byKey !== undefined) return store
        }
        cursor = cursor.return
      }
      return null
    }

    /** 按 chat 节点的 key 从仓库里取会话节点。 */
    function chatNodeOf(store, key) {
      if (store === null || store === undefined || key === null || key === undefined || key === '') return null
      const byKey = store.byKey
      if (byKey === null || byKey === undefined) return null
      try {
        if (typeof byKey.get === 'function') return byKey.get(key) === undefined ? null : byKey.get(key)
        if (typeof byKey === 'object') return byKey[key] === undefined ? null : byKey[key]
      } catch {
        return null
      }
      return null
    }

    /**
     * 读提问原文。官方把问答折在工具行里，点开才渲染——可点开会展开折叠、把页面滚动带跑。
     * 走只读路径：React 把句柄挂在 DOM 节点上（__reactFiber$…），顺着 return 链找到节点仓库，
     * 再按 data-chat-node-key 取出这次调用，题干就在里面。不点击、不展开、不改 DOM。
     */
    function questionTextsFromNode(node) {
      if (node === null || node === undefined || typeof node !== 'object') return []
      const out = []
      const seen = new Set()
      const store = nodeStoreOf(node)
      if (store !== null) {
        let key = ''
        try {
          key = String(node.getAttribute('data-chat-node-key') || node.getAttribute('data-chat-flow-key') || '')
        } catch {
          key = ''
        }
        const chatNode = chatNodeOf(store, key)
        if (chatNode !== null) {
          try {
            collectQuestionTexts(chatNode, 0, out, seen)
          } catch {
            // 节点数据里可能有取值抛错的字段，读不到就当没有
          }
        }
      }
      if (out.length > 0) return out
      // 兜底：仓库结构变了就去翻组件属性（浅层，代价小）。
      let fiber = null
      try {
        for (const name of Object.keys(node)) {
          if (name.indexOf('__reactFiber$') === 0 || name.indexOf('__reactInternalInstance$') === 0) {
            fiber = node[name]
            break
          }
        }
      } catch {
        return []
      }
      if (fiber === null || fiber === undefined) return []
      for (let depth = 0; depth < 14 && fiber !== null && fiber !== undefined; depth++) {
        try {
          collectQuestionTexts(fiber.memoizedProps, 0, out, seen)
        } catch {
          // 属性树里可能有取值抛错的东西，跳过这一层继续往上找
        }
        if (out.length >= 4) break
        fiber = fiber.return
      }
      return out
    }

    /** 提问组里的工具行：文案以「提问」开头的那条，它身上挂着这次的问答。 */
    function questionTextsFromSeat(seat) {
      if (seat === null || seat === undefined || typeof seat.querySelectorAll !== 'function') return []
      let rows = []
      try {
        rows = seat.querySelectorAll('[data-chat-flow-kind="tool-call"]')
      } catch {
        return []
      }
      for (const row of rows) {
        const flat = String(row.textContent || '').replace(/\s+/g, ' ').trim()
        if (flat.indexOf('提问') !== 0) continue
        const texts = questionTextsFromNode(row)
        if (texts.length > 0) return texts
      }
      return []
    }

    function collectPanelEntries(flow) {
      const entries = []
      if (flow === null || flow === undefined || typeof flow.querySelectorAll !== 'function') return entries
      const seats = new Set()
      for (const element of flow.querySelectorAll('[data-chat-flow-key]')) {
        const isSeat = typeof element.hasAttribute === 'function' && element.hasAttribute('data-step-process')
        const hidden = isHidden(element)
        // 收起的过程组也进面板：屏幕上它收成一条「已完成，用时…」的汇总行，
        // 组里的提问与工具不该跟着从面板里消失。组内的行仍由席位代表，不重复列。
        if (hidden && !isSeat) continue
        if (!hidden) {
          const rect = safeRect(element)
          if (rect === null || rect.width <= 0 || rect.height <= 0) continue
        }
        if (isSeat) {
          seats.add(element)
          const type = seatType(element)
          let text = excerptEntry(seatContentText(element), PANEL_ENTRY_TEXT)
          let detail = null
          // 提问组：官方那行只写「提问1/1 已回答」，题干要从节点自带的数据里读——
          // 不展开、不点击，页面一动不动。
          if (type === 'question') {
            const questions = questionTextsFromSeat(element)
            if (questions.length > 0) {
              text = excerptEntry(questions[0], PANEL_ENTRY_TEXT)
              detail = questions.join(' ／ ')
            }
          }
          entries.push({ el: element, type, text, detail, hidden })
          continue
        }
        let owner = null
        try {
          owner = typeof element.closest === 'function' ? element.closest('[data-step-process]') : null
        } catch {
          owner = null
        }
        if (owner !== null && owner !== undefined && owner !== element && seats.has(owner)) continue
        const type = panelTypeOfKind(element.getAttribute('data-chat-flow-kind'))
        if (type === null) continue
        entries.push({ el: element, type, text: excerptText(element.textContent, PANEL_ENTRY_TEXT) })
      }
      return mergeAnswerRuns(entries)
    }

    /**
     * 跳到某个条目。
     * 有真滚动容器就直接写它的 scrollTop：官方聊天区的「跟随底部」会在 scrollIntoView
     * 之后把位置拉回底部，那正是「点了像没反应」的来源（2026-10-23 真机取证）。
     * 量不到滚动容器时退回 scrollIntoView。
     */
    function scrollToElement(element) {
      const scroller = state.scrollEl
      if (scroller !== null && scroller !== undefined && typeof scroller.scrollTop === 'number') {
        const rect = safeRect(element)
        const box = safeRect(scroller)
        if (rect !== null && box !== null) {
          const scrollable = Number.isFinite(scroller.scrollHeight) && Number.isFinite(scroller.clientHeight)
          const max = scrollable ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : Infinity
          const raw = scroller.scrollTop + (rect.top - box.top) - PANEL_TOP_PAD
          scroller.scrollTop = Math.max(0, Math.min(raw, max))
          return true
        }
      }
      if (typeof element.scrollIntoView !== 'function') return false
      try {
        element.scrollIntoView({ block: 'center' })
      } catch {
        element.scrollIntoView()
      }
      return true
    }

    /**
     * 收起的过程组靠官方的 beforematch 展开：ui-chat 在带 hidden 的元素上挂了监听，
     * 收到就把那一回合重新展开（find-in-page 用的就是这条通路）。
     */
    function revealHidden(element) {
      if (element === null || element === undefined || typeof element.closest !== 'function') return null
      let hidden = null
      try {
        hidden = element.closest('[hidden]')
      } catch {
        hidden = null
      }
      if (hidden === null || hidden === undefined) return null
      try {
        hidden.dispatchEvent(new Event('beforematch'))
        return hidden
      } catch {
        return null
      }
    }

    /**
     * 跳转入口。条目在收起的回合里时，先展开再等它长出真实位置，
     * 展开失败（官方改版、组被卸掉）就退回折叠行本身。
     */
    function jumpToEntry(entry) {
      const element = entry !== null && entry !== undefined && entry.el !== undefined ? entry.el : entry
      if (element === null || element === undefined) return false
      if (entry !== null && entry !== undefined && entry.hidden === true) {
        const folded = revealHidden(element)
        if (folded !== null) {
          let tries = 0
          const attempt = () => {
            if (state.disposed) return
            tries += 1
            const rect = safeRect(element)
            if (rect !== null && rect.height > 0) {
              scrollToElement(element)
              return
            }
            if (tries < 12) {
              setTimeout(attempt, 70)
              return
            }
            scrollToElement(folded)
          }
          setTimeout(attempt, 70)
          return true
        }
      }
      return scrollToElement(element)
    }

    /** 清掉不是这一份的面板节点：热替换会在 body 下留下上一版的那块。 */
    function detachStalePanels(keep) {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
      let nodes = []
      try {
        nodes = document.querySelectorAll('[data-dcg-panel]')
      } catch {
        return
      }
      for (const node of nodes) {
        if (node === keep) continue
        try {
          node.remove()
        } catch {
          // 拆不掉就不动它
        }
      }
    }

    /**
     * 把「快速移动」按钮挂进容器（输入区插槽的根元素），两列面板挂到 body 下。
     * 面板不放在插槽里：输入区祖先只要带 transform / filter / contain，
     * position:fixed 就改认那个祖先做参照，面板会回到文档流把输入区撑变形。
     * 幂等：已挂过就换位置不重复建。
     */
    /**
     * 插槽容器改成居中 flex。这层容器由插件自己渲染，父级往往带 19px 字号 / 29px 行高，
     * 里面放 inline-flex 按钮时，浏览器按文字基线排版，按钮会被行高顶下去约 2px，
     * 跟同一行的 Prompt 之类按钮错开。容器变 flex 后行高不再参与计算。
     * 只认自己渲染的容器，别人家的节点一律不碰。
     */
    function alignNavContainer(container) {
      if (container === null || container === undefined || container.style === undefined) return
      let own = false
      try {
        own = typeof container.getAttribute === 'function' && container.getAttribute('data-dsh-gutter-nav-root') === '1'
      } catch {
        own = false
      }
      if (!own) return
      container.style.display = 'flex'
      container.style.alignItems = 'center'
    }

    function mountNav(container) {
      if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return null
      const host = document.body !== null && document.body !== undefined ? document.body : document.documentElement
      alignNavContainer(container)
      let root = document.getElementById(NAV_ID)
      if (root !== null && root !== undefined && (root.isConnected === false || root.__dcgInstance !== INSTANCE)) {
        // 热替换留下的旧节点连它的旧监听一起作废：新代码必须管到自己建的那一份。
        try {
          root.remove()
        } catch (error) {
          // 拆不掉也照样往下重建，不复用旧节点
        }
        root = null
      }
      if (root !== null && root !== undefined) {
        if (container !== null && container !== undefined && root.parentNode !== container) container.appendChild(root)
        return root
      }
      root = document.createElement('div')
      root.id = NAV_ID
      root.className = 'dcg-nav'
      root.__dcgInstance = INSTANCE

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dcg-nav-btn'
      button.setAttribute('data-dsh-gutter-nav-btn', '1')
      button.textContent = '快速移动'
      button.title = '点开选择要去哪一处'

      const panel = document.createElement('div')
      panel.id = PANEL_ID
      panel.className = 'dcg-panel'
      panel.setAttribute('data-dcg-panel', '1')
      panel.style.display = 'none'

      const catCol = document.createElement('div')
      catCol.className = 'dcg-panel-cats'
      const entryCol = document.createElement('div')
      entryCol.className = 'dcg-panel-entries'
      // 左列与右列横排在 body 里，底部那条「加载更早」单独占整行。
      const panelBody = document.createElement('div')
      panelBody.className = 'dcg-panel-body'
      panelBody.appendChild(catCol)
      panelBody.appendChild(entryCol)

      const moreBtn = document.createElement('button')
      moreBtn.type = 'button'
      moreBtn.className = 'dcg-panel-more'
      moreBtn.setAttribute('data-dcg-more', '1')
      moreBtn.style.display = 'none'

      panel.appendChild(panelBody)
      panel.appendChild(moreBtn)

      const catButtons = []
      for (const spec of PANEL_CATEGORIES) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'dcg-cat'
        item.setAttribute('data-dcg-cat', spec.type)
        item.setAttribute('data-count', '0')
        item.setAttribute('data-empty', '1')
        item.textContent = spec.icon + ' ' + spec.label
        item.addEventListener('click', () => selectCategory(spec.type))
        catCol.appendChild(item)
        catButtons.push({ el: item, spec })
      }

      let entries = []
      let current = null
      let placeRaf = null

      /**
       * 面板底部的「加载更早」：官方那个按钮在就跟着出现，不在就整条不出现。
       * 官方正在加载时文案同步成「加载中…」并禁用，和页面上那个按钮表现一致。
       */
      function refreshLoadEarlier() {
        const target = findLoadEarlier(state.flowEl)
        if (target === null) {
          moreBtn.style.display = 'none'
          moreBtn.disabled = false
          moreBtn.textContent = ''
          moreBtn.removeAttribute('title')
          return
        }
        const busy = isDisabledButton(target)
        moreBtn.disabled = busy
        moreBtn.textContent = busy ? '加载中…' : '⬆️ 加载更早'
        moreBtn.title = busy ? '官方正在加载更早的历史' : '点一次补一页更早的历史（等于点页面上那个按钮）'
        moreBtn.style.display = 'block'
      }

      moreBtn.addEventListener('click', () => {
        if (moreBtn.disabled === true) return
        // 每次点都重新找：面板开着的时候那条历史可能已经加载完了。
        const target = findLoadEarlier(state.flowEl)
        if (target === null) {
          closePanel()
          return
        }
        if (isDisabledButton(target)) return
        try {
          if (typeof target.click === 'function') target.click()
        } catch (error) {
          console.warn(LOG, '点「加载更早」失败', error)
        }
        closePanel()
      })

      function closePanel() {
        panel.style.display = 'none'
        button.setAttribute('data-open', '0')
      }

      function selectCategory(type) {
        current = type
        entryCol.setAttribute('data-dcg-list', type)
        for (const item of catButtons) {
          item.el.setAttribute('data-active', item.spec.type === type ? '1' : '0')
        }
        while (entryCol.children.length > 0) entryCol.children[0].remove()
        const list = []
        for (const entry of entries) {
          if (entry.type === type) list.push(entry)
        }
        if (list.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'dcg-panel-empty'
          empty.setAttribute('data-dcg-empty', '1')
          empty.textContent = '这一类还没有'
          entryCol.appendChild(empty)
          return
        }
        for (let index = 0; index < list.length; index++) {
          const entry = list[index]
          const item = document.createElement('button')
          item.type = 'button'
          item.className = 'dcg-entry'
          item.setAttribute('data-dcg-entry', String(index + 1))
          const text = entry.text === '' ? '（无文字）' : entry.text
          item.textContent = (index + 1) + ' · ' + text
          // 悬停看全文：提问条目给的是题干（多个提问全列出来），其余就是摘要本身。
          item.title = entry.detail !== null && entry.detail !== undefined && entry.detail !== '' ? entry.detail : text
          item.addEventListener('click', () => {
            jumpToEntry(entry)
            closePanel()
          })
          entryCol.appendChild(item)
        }
      }

      /** 按按钮位置摆面板：左边夹进窗口，底边贴着按钮上沿。 */
      function placePanel() {
        try {
          const rect = button.getBoundingClientRect()
          const width = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 0
          const height = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0
          const left = Math.max(8, Math.min(rect.left, width - PANEL_WIDTH - 8))
          panel.style.left = Math.round(left) + 'px'
          panel.style.top = 'auto'
          panel.style.bottom = Math.round(height - rect.top + 8) + 'px'
          return { button: rect, height }
        } catch {
          // 量不到按钮位置就让 CSS 的兜底位置生效。
          return null
        }
      }

      /** 面板高度只有显示后才知道：上面装不下就翻到按钮下面。 */
      function flipPanelDown(geo) {
        let box = null
        try {
          box = panel.getBoundingClientRect()
        } catch {
          box = null
        }
        if (box === null || box === undefined || box.height <= 0 || box.top >= 8) return
        const top = Math.max(8, Math.min(Math.round(geo.button.bottom + 8), geo.height - box.height - 8))
        panel.style.top = Math.round(top) + 'px'
        panel.style.bottom = 'auto'
      }

      function showPanel() {
        entries = collectPanelEntries(state.flowEl)
        const counts = { question: 0, tool: 0, answer: 0, ask: 0 }
        for (const entry of entries) counts[entry.type] += 1
        let fallback = null
        for (const item of catButtons) {
          const count = counts[item.spec.type]
          item.el.setAttribute('data-count', String(count))
          item.el.setAttribute('data-empty', count === 0 ? '1' : '0')
          item.el.textContent = item.spec.icon + ' ' + item.spec.label + ' ' + count
          if (fallback === null && count > 0) fallback = item.spec.type
        }
        // 优先留在这个分类；空空的就跳到第一个有货的分类。
        const target = counts[current] > 0 ? current : (fallback === null ? PANEL_CATEGORIES[0].type : fallback)
        selectCategory(target)
        // 先定底部那条要不要出现，再量面板高度：翻到按钮下面时高度得算上它。
        refreshLoadEarlier()
        const geo = placePanel()
        panel.style.display = 'flex'
        if (geo !== null) flipPanelDown(geo)
        button.setAttribute('data-open', '1')
      }

      button.addEventListener('click', () => {
        if (panel.style.display === 'none') showPanel()
        else closePanel()
      })
      button.addEventListener('contextmenu', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        showPanel()
      })
      // 面板挂在 body 下，不在 root 里：判据要同时认按钮和面板两块。
      const onDocClick = (event) => {
        if (panel.style.display === 'none') return
        const target = event === null || event === undefined ? null : event.target
        if (target !== null && target !== undefined) {
          if (typeof root.contains === 'function' && root.contains(target)) return
          if (typeof panel.contains === 'function' && panel.contains(target)) return
        }
        closePanel()
      }
      const onDocKey = (event) => {
        if (event && event.key === 'Escape' && panel.style.display !== 'none') closePanel()
      }
      // 窗口尺寸变了或页面滚了：面板要跟着按钮重新摆位，别悬在半空。
      const schedulePlace = () => {
        if (panel.style.display === 'none') return
        if (placeRaf !== null) return
        const run = () => {
          placeRaf = null
          const geo = placePanel()
          if (geo !== null) flipPanelDown(geo)
        }
        placeRaf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16)
      }
      document.addEventListener('click', onDocClick)
      document.addEventListener('keydown', onDocKey)
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('resize', schedulePlace)
        window.addEventListener('scroll', schedulePlace, true)
      }
      // 收起或卸载时把监听撤掉：热替换会反复挂新实例，不能一层层堆着。
      function unbind() {
        try {
          document.removeEventListener('click', onDocClick)
          document.removeEventListener('keydown', onDocKey)
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('resize', schedulePlace)
            window.removeEventListener('scroll', schedulePlace, true)
          }
        } catch {
          // 撤不掉就算了，节点都要没了
        }
        if (placeRaf !== null) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(placeRaf)
          else clearTimeout(placeRaf)
          placeRaf = null
        }
      }

      root.appendChild(button)
      if (host !== null && host !== undefined) host.appendChild(panel)
      // 上一版留下的面板（body 下或还挂在旧节点里）清掉，页面上只留这一份。
      detachStalePanels(panel)
      if (container !== null && container !== undefined) container.appendChild(root)
      else if (host !== null && host !== undefined) host.appendChild(root)
      state.navPanel = panel
      state.navUnbind = unbind
      return root
    }

    /** React 插槽组件：渲染一个容器，真机由 ref 回调挂原生 DOM。 */
    function QuickNav(props) {
      return h('div', {
        key: 'dsh-chat-gutter-nav-root',
        ref: (element) => {
          if (element !== null && element !== undefined) mountNav(element)
        },
        'data-dsh-gutter-nav-root': '1',
      })
    }


    function questionMarkers() {
      const markers = []
      if (typeof document === 'undefined' || !document.querySelectorAll) return markers
      const nodes = document.querySelectorAll('[data-question-key]')
      const seen = new Set()
      for (const element of nodes) {
        if (isHidden(element)) continue
        const key = String(element.getAttribute('data-question-key') || '')
        if (key !== '' && seen.has(key)) continue
        if (key !== '') seen.add(key)
        markers.push({
          key: 'question:' + (key || markers.length),
          kind: 'badge',
          text: '🤔提问',
          anchors: [element],
        })
      }
      return markers
    }

    /**
     * 答过的提问：历史里只剩过程组那一行（文案「向用户提出了问题」），提问卡已经撤掉，
     * 所以补一条 🤔 钉在这一行上，免得左带里提问完全看不见。
     * 收起状态高度为 0，量不到位置；等它展开后下一轮扫描再画。
     */
    function answeredQuestionMarkers(flow) {
      const markers = []
      if (flow === null || flow === undefined || typeof flow.querySelectorAll !== 'function') return markers
      let index = 0
      for (const seat of flow.querySelectorAll('[data-step-process]')) {
        if (seatType(seat) !== 'question') continue
        if (isHidden(seat)) continue
        const rect = safeRect(seat)
        if (rect === null || rect.height <= 0) continue
        const header = seat.children !== undefined && seat.children !== null && seat.children.length > 0 ? seat.children[0] : seat
        index += 1
        markers.push({
          key: 'asked:' + String(seat.getAttribute('data-chat-flow-key') || index),
          kind: 'badge',
          text: '🤔',
          anchors: [header],
        })
      }
      return markers
    }

    function answerMarkers(rows, markedKeys) {
      if (markedKeys.size === 0) return []
      const markers = []
      for (const row of rows) {
        if (!markedKeys.has(row.key)) continue
        // ▶答 每段只出一个，钉在整段弧线的中点（见 markerTop 的 answer 分支）；整段由蓝线表达。
        if (row.el.getAttribute('data-dsh-answer-first') !== '1') continue
        markers.push({
          key: 'answer:' + row.key,
          kind: 'answer',
          text: '▶答',
          anchors: [row.el],
        })
      }
      return markers
    }

    // ================================================================
    // 回答起点属性
    // ================================================================

    function applyAnswerMarks(rows, mode) {
      const markedKeys = new Set(planAnswerMarks(rows, mode))
      const next = new Set()
      const orderedRows = []
      for (const row of rows) {
        if (!markedKeys.has(row.key)) continue
        next.add(row.el)
        orderedRows.push(row)
        if (row.el.getAttribute(ANSWER_ATTR) !== '1') row.el.setAttribute(ANSWER_ATTR, '1')
      }
      // 段首：▶答 只出在段首行；相邻行 turn 不同即断段。
      for (let i = 0; i < orderedRows.length; i++) {
        const element = orderedRows[i].el
        const prev = orderedRows[i - 1]
        const first = prev === undefined || prev.turn !== orderedRows[i].turn
        if (first) element.setAttribute('data-dsh-answer-first', '1')
        else element.removeAttribute('data-dsh-answer-first')
      }
      for (const element of state.answerEls) {
        if (!next.has(element) && typeof element.removeAttribute === 'function') {
          element.removeAttribute(ANSWER_ATTR)
          element.removeAttribute('data-dsh-answer-first')
        }
      }
      state.answerEls = next
      return markedKeys
    }

    function clearAnswerMarks() {
      if (typeof document === 'undefined' || !document.querySelectorAll) {
        state.answerEls.clear()
        return
      }
      const nodes = document.querySelectorAll('[' + ANSWER_ATTR + '="1"]')
      for (const element of nodes) element.removeAttribute(ANSWER_ATTR)
      state.answerEls.clear()
    }

    // ================================================================
    // 渲染与定位
    // ================================================================

    function overlayLeft(flow) {
      const content = measureContent(flow)
      if (content === null || content.width < 160) return null
      return gutterLeft(content.left, GUTTER_WIDTH, GUTTER_GAP, GUTTER_MARGIN)
    }

    function overlayRight(flow) {
      const content = measureContent(flow)
      if (content === null || content.width < 160) return null
      const right = measureContentRight(flow)
      if (right === null) return null
      const width = right - content.left
      if (!(width > 0)) return null
      return gutterRight(content.left, width, GUTTER_WIDTH, GUTTER_GAP, GUTTER_MARGIN, viewportWidth())
    }

    /** left 为 null 表示这条带放不下，整条隐藏。 */
    function showBand(overlay, left) {
      if (overlay === null) return
      if (left === null) {
        overlay.style.display = 'none'
        return
      }
      overlay.style.display = 'block'
      overlay.style.transform = 'translateX(' + Math.round(left) + 'px)'
      overlay.style.width = GUTTER_WIDTH + 'px'
    }

    /** 编号画在右侧带，其余徽标画在左侧带。 */
    function sideOf(marker) {
      return marker.kind === 'num' ? 'right' : 'left'
    }

    function bandOf(side) {
      return side === 'right' ? state.overlayRight : state.overlay
    }

    function reconcileMarkers(desired) {
      if (state.overlay === null && state.overlayRight === null) return
      const wanted = new Map()
      for (const marker of desired) {
        if (!wanted.has(marker.key)) wanted.set(marker.key, marker)
      }
      for (const [key, record] of state.markers) {
        if (!wanted.has(key)) {
          if (typeof record.el.remove === 'function') record.el.remove()
          state.markers.delete(key)
        }
      }
      for (const [key, marker] of wanted) {
        let record = state.markers.get(key)
        if (record === undefined) {
          const element = document.createElement('div')
          record = { el: element, text: '', className: '', side: null }
          state.markers.set(key, record)
        }
        const side = sideOf(marker)
        const target = bandOf(side)
        if (target !== null && (record.side !== side || record.el.parentNode !== target)) {
          target.appendChild(record.el)
          record.side = side
        }
        if (record.text !== marker.text) {
          record.el.textContent = marker.text
          record.text = marker.text
        }
        const className = marker.kind === 'num'
          ? 'dcg-marker dcg-num'
          : marker.kind === 'answer'
            ? 'dcg-marker dcg-badge dcg-answer'
            : 'dcg-marker dcg-badge'
        if (record.className !== className) {
          record.el.className = className
          record.className = className
        }
        record.marker = marker
      }
    }

    /**
     * 徽标 / 编号 / ▶答 的纵向落点。
     * num：回合第一行的顶。badge：锚点行文字的中线（汇总条优先量官方文字 span 的真实盒子，
     * 量不到退回「按钮盒去掉官方 8px 底边距」）。answer：整段弧线的中点，中点滚出视口就贴在
     * 弧线可见部分的上/下缘，跟着滚不消失。
     */
    function markerTop(marker, viewportHeight) {
      let best = null
      for (const element of marker.anchors) {
        if (isHidden(element)) continue
        const rect = safeRect(element)
        if (marker.kind === 'answer') {
          // ▶答 的显隐只看「裁剪后的弧线还剩不剩」：段首行滚出屏幕不算消失的理由。
          const answerTop = arcMidTop(element, viewportHeight)
          if (answerTop !== null && (best === null || answerTop < best)) best = answerTop
          continue
        }
        if (!isOnScreen(rect, viewportHeight)) continue
        let top = rect.top
        if (marker.kind === 'badge') top = badgeAnchorTop(element, rect)
        if (best === null || top < best) best = top
        if (marker.kind === 'num') break
      }
      return best
    }

    /**
     * 过程徽标的纵向基准：锚点行里文字的真实中线。
     * 官方回合汇总条是「按钮盒高 33px + 底部 8px 内边距、文字被顶上去」，
     * 直接量文字 span 最准；量不到 span 就按 8px 折算；都不是就取行盒子中线。
     */
    function badgeAnchorTop(element, rect) {
      if (typeof element.querySelector === 'function') {
        const button = element.querySelector('[data-turn-process]')
        if (button !== null) {
          const label = typeof button.querySelector === 'function' ? button.querySelector('span') : null
          if (label !== null) {
            const labelRect = safeRect(label)
            if (labelRect !== null && labelRect.height > 0) return labelRect.top + labelRect.height / 2
          }
          const buttonRect = safeRect(button)
          if (buttonRect !== null && buttonRect.height > 0) {
            // 官方样式：height:33px+; padding:0 0 8px → 文字中线 = (高-8)/2。
            return buttonRect.top + Math.max(0, buttonRect.height - 8) / 2
          }
        }
      }
      return rect.top + Math.max(0, Math.min(rect.height, FLOW_MAX_HEIGHT)) / 2
    }

    /**
     * 从聊天流往上找真正的滚动容器。
     * 判据一：官方给滚动容器打的固定属性 data-conversation-scroll（真机上是聊天流往上第 9 个
     * 盒子，外面还套着消息列、框架与两个槽位外壳）；判据二：overflow-y 为 auto/scroll/overlay。
     * 正文正是在这一层被裁掉的，弧线要裁在同一条线上；父列装的是全部内容、比屏幕高得多，
     * 拿它当裁剪线等于没裁。
     */
    function findScrollContainer() {
      const flow = state.flowEl
      if (flow === null || flow === undefined) return null
      if (typeof flow.closest === 'function') {
        let marked = null
        try {
          marked = flow.closest('[data-conversation-scroll]')
        } catch {
          marked = null
        }
        if (marked !== null && marked !== undefined && marked !== flow) {
          const markedRect = safeRect(marked)
          if (markedRect !== null && markedRect.height > 0) return marked
        }
      }
      if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null
      let node = flow
      for (let depth = 0; depth < 16 && node !== null && node !== undefined; depth++) {
        if (node.isConnected === false) break
        let style = null
        try {
          style = window.getComputedStyle(node)
        } catch {
          return null
        }
        const overflowY = style === null || style === undefined ? '' : String(style.overflowY || '').toLowerCase()
        if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
          const rect = safeRect(node)
          if (rect !== null && rect.height > 0) return node
        }
        node = node.parentNode
      }
      return null
    }

    /**
     * 弧线与 ▶答 的裁剪窗口：正文可视区。
     * 首选滚动容器的盒子；量不到时退到聊天流自己或近处祖先，但只认不比窗口高的盒子
     * —— 内容列往往比窗口高好几倍、上边跑到屏幕外，拿它当裁剪线等于没裁 ——
     * 并且夹进屏幕可视区；都量不到就用整个视口。
     */
    function flowClipRect() {
      const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800
      const scroller = state.scrollEl
      if (scroller !== null && scroller !== undefined && scroller.isConnected !== false) {
        const rect = safeRect(scroller)
        if (rect !== null && rect.height > 0) return { top: rect.top, bottom: rect.bottom }
      }
      let node = state.flowEl
      for (let depth = 0; depth < 3 && node !== null && node !== undefined; depth++) {
        if (node.isConnected === false) break
        const rect = safeRect(node)
        if (rect !== null && rect.height > 0 && rect.height <= viewportHeight * 1.2) {
          const top = Math.max(rect.top, 0)
          const bottom = Math.min(rect.bottom, viewportHeight)
          if (bottom - top >= 40) return { top, bottom }
        }
        node = node.parentNode
      }
      return { top: 0, bottom: viewportHeight }
    }

    /** ▶答 的纵向基准：这一段弧线（裁剪后）的中点；中点滚出视口时贴可见部分的上/下缘。 */
    function arcMidTop(anchorElement, viewportHeight) {
      const segment = state.answerSegments.find((item) => item.first === anchorElement || item.last === anchorElement)
      if (segment === undefined) return null
      const firstRect = safeRect(segment.first)
      const lastRect = safeRect(segment.last)
      if (firstRect === null || lastRect === null || firstRect.height <= 0 || lastRect.height <= 0) return null
      // 与 refreshAnswerLines 同一坐标系：弧线两端各外延 4px，长度按段落真实长度算。
      const clip = flowClipRect()
      const arcTop = Math.min(firstRect.top, lastRect.top) - 4
      const arcBottom = Math.max(firstRect.bottom, lastRect.bottom) + 4
      if (arcBottom - arcTop < 12) return null
      // 整段都不在正文可视区里就没有落点：标记随弧线一起消失，不许钉在窗口边。
      const visibleTop = Math.max(arcTop, clip.top)
      const visibleBottom = Math.min(arcBottom, clip.bottom)
      if (visibleBottom - visibleTop < 12) return null
      const mid = (arcTop + arcBottom) / 2
      // 中点落在可见部分里就用中点（跟着内容走、不随滚动伸缩）；离开可见部分就贴它的上/下缘。
      const edge = Math.min(Math.max(mid, visibleTop), visibleBottom)
      const low = clip.top + MARKER_EDGE
      const high = Math.min(clip.bottom, viewportHeight) - MARKER_EDGE
      if (high < low) return null
      return Math.min(Math.max(edge, low), high)
    }

    function positionBand(overlay, rail, side, viewportHeight, clip) {
      if (overlay === null || overlay.style.display === 'none') return

      const entries = []
      for (const record of state.markers.values()) {
        if (record.side !== side) continue
        const marker = record.marker
        if (marker === undefined) {
          record.el.style.display = 'none'
          continue
        }
        const top = markerTop(marker, viewportHeight)
        if (top === null) {
          record.el.style.display = 'none'
          continue
        }
        record.el.style.display = ''
        entries.push({ record, top })
      }

      const placed = layoutMarkers(entries.map((entry) => ({ key: entry.record, top: entry.top })), MARKER_GAP)
      const tops = new Map()
      for (const item of placed) tops.set(item.key, item.top)
      let railTop = null
      let railBottom = null
      for (const entry of entries) {
        const top = tops.get(entry.record)
        if (typeof top !== 'number') {
          entry.record.el.style.display = 'none'
          continue
        }
        if (top < clip.top + MARKER_EDGE || top > Math.min(clip.bottom, viewportHeight) - MARKER_EDGE) {
          entry.record.el.style.display = 'none'
          continue
        }
        entry.record.el.style.top = Math.round(top) + 'px'
        if (railTop === null || top < railTop) railTop = top
        if (railBottom === null || top > railBottom) railBottom = top
      }
      if (rail !== null) {
        if (railTop !== null && railBottom !== null && railBottom > railTop) {
          rail.style.display = 'block'
          rail.style.top = Math.round(railTop + 6) + 'px'
          rail.style.height = Math.round(railBottom - railTop) + 'px'
        } else {
          rail.style.display = 'none'
        }
      }
    }

    /**
     * 覆盖层自己的裁剪：只画在正文可视区里。
     * 徽标落点再准也难免有半个像素溢出，clip-path 是最后一道闸 —— 标题栏里永远不会出现任何标记。
     * 写过的值单独记：浏览器会把 clip-path 的第四个值归一化掉，拿读回值当缓存会每帧重写。
     */
    function syncOverlayClip(overlay, clip, viewportHeight) {
      if (overlay === null || overlay === undefined) return
      const topInset = Math.max(0, Math.round(clip.top))
      const bottomInset = Math.max(0, Math.round(viewportHeight - clip.bottom))
      const value = 'inset(' + topInset + 'px 0px ' + bottomInset + 'px 0px)'
      if (overlayClips.get(overlay) === value) return
      overlayClips.set(overlay, value)
      overlay.style.clipPath = value
    }

    function position() {
      if (!state.engineOn) return
      const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800
      const clip = flowClipRect()
      syncOverlayClip(state.overlay, clip, viewportHeight)
      syncOverlayClip(state.overlayRight, clip, viewportHeight)
      positionBand(state.overlay, state.rail, 'left', viewportHeight, clip)
      positionBand(state.overlayRight, state.railRight, 'right', viewportHeight, clip)
    }

    function countMatches(scope, selector) {
      if (scope === null || scope === undefined || typeof scope.querySelectorAll !== 'function') return 0
      return scope.querySelectorAll(selector).length
    }

    /**
     * 结构指纹：只收「会让标记集合变化」的信号，外加配置位。
     * 指纹一样就说明只是文字在长（流式吐字）、坐标在动或滚动 —— 扫描走只量坐标的快路，
     * 一次重建都不做，也就不会把覆盖层写个没完。
     */
    function structureSignature(flow) {
      const parts = [state.cfg.showNumbers ? '1' : '0', state.cfg.showBadges ? '1' : '0', state.cfg.answerMark]
      let rows = 0
      if (flow !== null && typeof flow.querySelectorAll === 'function') {
        for (const element of flow.querySelectorAll('[data-chat-flow-key]')) {
          const kind = element.getAttribute('data-chat-flow-kind')
          if (kind === null) continue
          if (element.hasAttribute('data-chat-group-key')) continue
          const key = element.getAttribute('data-chat-flow-key')
          if (key === null || key === '') continue
          rows += 1
          // 正文行「有没有字」决定 ▶答 与弧线出不出，流式吐字时它从无到有。
          const filled = ANSWER_KINDS.has(kind) ? (rowHasText(element) ? 't' : 'f') : '-'
          parts.push(
            key,
            kind,
            element.getAttribute('data-chat-turn') || '',
            isHidden(element) ? 'h' : 'v',
            element.getAttribute('data-chat-group-part') || '',
            element.getAttribute('data-turn-process-tool-calls') || '',
            filled,
          )
        }
      }
      const containers = [
        countMatches(flow, '[data-variant="think"]'),
        countMatches(flow, '[data-step-process]'),
        countMatches(flow, '[data-turn-process]'),
      ]
      const questions = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
        ? document.querySelectorAll('[data-question-key]').length
        : 0
      return rows + '|' + questions + '|' + containers.join(',') + '|' + parts.join('\u0001')
    }

    function scan() {
      if (!state.engineOn || state.disposed) return
      if (typeof document === 'undefined' || !document.body) {
        scheduleScan(120)
        return
      }
      ensureOverlay()
      if (state.overlay === null) {
        scheduleScan(120)
        return
      }
      const flow = findFlow()
      if (flow === null) {
        state.structureSignature = null
        state.lastScanAt = Date.now()
        showBand(state.overlay, null)
        showBand(state.overlayRight, null)
        return
      }
      bindFlow(flow)
      state.lastScanAt = Date.now()
      const signature = structureSignature(flow)
      if (signature === state.structureSignature) {
        // 快路：结构没变。只量带宽与坐标、顺一遍弧线几何，不碰任何标记。
        state.scanCheap += 1
        showBand(state.overlay, overlayLeft(flow))
        showBand(state.overlayRight, overlayRight(flow))
        position()
        refreshAnswerLines()
        return
      }
      state.structureSignature = signature
      state.scanFull += 1
      const rows = collectRows(flow)
      const marked = state.cfg.answerMark === 'off' ? new Set() : applyAnswerMarks(rows, state.cfg.answerMark)
      if (state.cfg.answerMark === 'off') applyAnswerMarks(rows, 'off')

      showBand(state.overlay, overlayLeft(flow))
      showBand(state.overlayRight, overlayRight(flow))

      const desired = []
      if (state.cfg.showNumbers) {
        for (const marker of numberMarkers(rows)) desired.push(marker)
      }
      if (state.cfg.showBadges) {
        for (const marker of processBadgeMarkers(flow, rows)) desired.push(marker)
        for (const marker of questionMarkers()) desired.push(marker)
        for (const marker of answeredQuestionMarkers(flow)) desired.push(marker)
      }
      for (const marker of answerMarkers(rows, marked)) desired.push(marker)

      // 先把段成员表建好（▶答 要钉在弧线中点，需要这份表），再摆标记、定位。
      reconcileAnswerLines()
      reconcileMarkers(desired)
      position()

      if (!state.debugLogged && rows.length > 0) {
        state.debugLogged = true
        const kinds = []
        for (const row of rows) if (kinds.indexOf(row.kind) === -1) kinds.push(row.kind)
        console.info(LOG, '扫描到 ' + rows.length + ' 行；kind=' + kinds.join(','))
      }
    }

    /**
     * 回答段的整段弧线：每段一个 SVG（.dcg-answer-arc），里面一条 Q 贝塞尔曲线。
     * 起点在段首行顶部、终点在段尾行底部，控制点向左鼓出 —— 整条从上到下都是弧。
     *
     * 分两层保证滚动零延迟：
     *   reconcileAnswerLines —— 只在结构变化的全量扫描里跑：建/删 SVG、缓存段成员表；
     *   refreshAnswerLines  —— 滚动帧与结构未变的快路里跑：只读缓存的段表，量首尾行坐标、重设几个数字。
     */
    function reconcileAnswerLines() {
      const overlay = state.overlay
      if (overlay === null || overlay.style.display === 'none' || state.cfg.answerMark === 'off') {
        setAnswerLineCount(0)
        state.answerSegments = []
        return
      }
      // 段成员表按扫描序收（answerEls 是 Set，插入序即行序）。
      const segments = []
      let current = null
      for (const element of state.answerEls) {
        if (!element || element.isConnected === false) continue
        const turn = String(element.getAttribute('data-chat-turn') || '')
        if (current === null || current.turn !== turn) {
          current = { turn, first: element, last: element }
          segments.push(current)
        }
        current.last = element
      }
      state.answerSegments = segments
      let index = 0
      for (const segment of segments) {
        const svg = ensureAnswerLine(index)
        if (svg === null) break
        index += 1
      }
      setAnswerLineCount(index)
      refreshAnswerLines()
    }

    /** 滚动帧专用：只量坐标、只写几何，不碰 DOM 结构。 */
    function refreshAnswerLines() {
      const overlay = state.overlay
      if (overlay === null || overlay.style.display === 'none') return
      // 裁剪窗口 = 正文可视区（聊天流容器的盒子）。正文滚出这条线被裁掉，
      // 弧线也必须裁在同一条线上，不然正文没了、线还挂着，很突兀。
      const clip = flowClipRect()
      const segments = state.answerSegments
      for (let index = 0; index < segments.length && index < state.answerLines.length; index++) {
        const segment = segments[index]
        const svg = state.answerLines[index]
        if (svg === undefined || svg.isConnected === false) continue
        const firstRect = safeRect(segment.first)
        const lastRect = safeRect(segment.last)
        if (firstRect === null || lastRect === null || firstRect.height <= 0 || lastRect.height <= 0) {
          svg.style.display = 'none'
          continue
        }
        // 弧线长度 = 段落的真实长度（两端各外延 4px），不按可视区裁剪 —— 内容滚动时
        // 它跟着内容上下移动，长度与弧度都不变；超出正文可视区的部分由覆盖层的 clip-path 裁掉。
        const top = Math.min(firstRect.top, lastRect.top) - 4
        const bottom = Math.max(firstRect.bottom, lastRect.bottom) + 4
        const visible = Math.min(bottom, clip.bottom) - Math.max(top, clip.top)
        if (visible < 12) {
          // 整段不在正文可视区：和正文一起消失。
          svg.style.display = 'none'
          continue
        }
        const height = Math.round(bottom - top)
        // 花瓣画在 12px 宽的视窗里：两个尖端都在 x=12，外缘向左深鼓、内缘稍直，
        // 控制点相减的一半就是中段厚度（≈2.6px，随高度微调）。
        const bulge = Math.min(10, 6 + Math.round(height / 30))
        const thickness = Math.min(6, 2.6 + height / 400)
        const outerX = 12 - bulge
        const innerX = outerX + thickness * 2
        const midY = Math.round(height / 2)
        svg.style.top = Math.round(top) + 'px'
        svg.style.height = height + 'px'
        svg.setAttribute('viewBox', '0 0 12 ' + height)
        svg.setAttribute('width', '12')
        svg.setAttribute('height', String(height))
        svg.children[0].setAttribute('d',
          'M 12 1 Q ' + outerX + ' ' + midY + ' 12 ' + (height - 1)
          + ' Q ' + innerX + ' ' + midY + ' 12 1 Z')
        svg.style.display = 'block'
      }
    }

    /**
     * 滚动帧入口：rAF 合帧，一帧最多算一次。
     * 覆盖层是 position:fixed，徽标/编号/竖线的 top 都是视口坐标，滚动时全靠这一帧重算 ——
     * 只读缓存好的锚点坐标、只写几个数字，不重建元素、不排扫描，所以滚动零延迟。
     */
    function scheduleScrollFrame() {
      if (state.disposed || !state.engineOn) return
      if (state.scrollRaf !== null) return
      const run = () => {
        state.scrollRaf = null
        try {
          refreshAnswerLines()
        } catch (error) {
          console.error(LOG, '弧线刷新失败', error)
        }
        try {
          position()
        } catch (error) {
          console.error(LOG, '标记定位失败', error)
        }
      }
      if (typeof requestAnimationFrame === 'function') state.scrollRaf = requestAnimationFrame(run)
      else state.scrollRaf = setTimeout(run, 16)
    }

    function ensureAnswerLine(index) {
      const overlay = state.overlay
      if (overlay === null || typeof document === 'undefined' || typeof document.createElement !== 'function') return null
      const existing = state.answerLines[index]
      if (existing !== undefined && existing.isConnected !== false) return existing
      let svg = null
      let path = null
      if (typeof document.createElementNS === 'function') {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('fill', 'none')
      } else {
        // 桩环境没有 createElementNS：给一个可断言的最小替身（div + 路径对象）。
        svg = document.createElement('div')
        path = document.createElement('path')
      }
      svg.appendChild(path)
      // SVG 的 className 是只读属性，赋值会抛错 —— 类名必须走 setAttribute('class')。
      svg.setAttribute('class', 'dcg-answer-arc')
      svg.setAttribute('aria-hidden', 'true')
      overlay.appendChild(svg)
      state.answerLines[index] = svg
      return svg
    }

    function setAnswerLineCount(count) {
      const overlay = state.overlay
      if (overlay === null) return
      for (let i = count; i < state.answerLines.length; i++) {
        const line = state.answerLines[i]
        if (line !== undefined && typeof line.remove === 'function') line.remove()
      }
      state.answerLines.length = count
    }

    /**
     * 排一次扫描。
     * @param {number} [delay] 省略 = 结构检查（距上次扫描不短于 SCAN_INTERVAL）；
     *                         传数字 = 用这个最短等待（0 表示尽快、合并到下一帧）。
     */
    function scheduleScan(delay) {
      if (state.disposed || !state.engineOn) return
      if (state.scanTimer !== null || state.scanRaf !== null) return
      const now = Date.now()
      const wait = typeof delay === 'number' && delay >= 0
        ? delay
        : Math.max(0, state.lastScanAt + SCAN_INTERVAL - now)
      const run = () => {
        state.scanTimer = null
        state.scanRaf = null
        try {
          scan()
        } catch (error) {
          console.error(LOG, '扫描失败', error)
        }
      }
      // 还要等就挂定时器；能立刻跑就合并到下一帧，避免同一批变动跑多次。
      if (wait > 0 || typeof requestAnimationFrame !== 'function') state.scanTimer = setTimeout(run, wait)
      else state.scanRaf = requestAnimationFrame(run)
    }

    function schedulePosition() {
      if (state.disposed || !state.engineOn) return
      if (state.positionRaf !== null) return
      const run = () => {
        state.positionRaf = null
        try {
          position()
        } catch (error) {
          console.error(LOG, '定位失败', error)
        }
      }
      if (typeof requestAnimationFrame === 'function') state.positionRaf = requestAnimationFrame(run)
      else state.positionRaf = setTimeout(run, 16)
    }

    // ================================================================
    // 监听生命周期
    // ================================================================

    /** 这条变动是不是我们自己写覆盖层/导航按钮引起的（自激源头）。 */
    function isOwnRecord(record) {
      const target = record === null || record === undefined ? null : record.target
      if (target === null || target === undefined) return false
      const roots = [state.overlay, state.overlayRight, state.navPanel]
      if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
        roots.push(document.getElementById(NAV_ID))
      }
      for (const node of roots) {
        if (node === null || node === undefined) continue
        if (typeof node.contains === 'function' && node.contains(target)) return true
      }
      return false
    }

    /** 这条变动有没有带来一条新的聊天流容器（切会话/重新挂载）。 */
    function introducesFlow(record) {
      const added = record === null || record === undefined ? null : record.addedNodes
      if (added === null || added === undefined || typeof added.length !== 'number') return false
      for (const node of added) {
        if (node === null || node === undefined) continue
        if (typeof node.getAttribute === 'function' && node.getAttribute('data-slot') === 'conversation.chat.flow') return true
        if (typeof node.querySelector === 'function' && node.querySelector('[data-slot="conversation.chat.flow"]') !== null) return true
      }
      return false
    }

    function onBodyMutation(records) {
      if (state.disposed || !state.engineOn) return
      const list = Array.isArray(records) ? records : []
      // 聊天流已经在手且还挂在文档里：正文变动交给 flow 观察器，
      // 只有冒出一条新的聊天流才回来重找（切会话）。
      if (state.flowEl !== null && state.flowEl.isConnected !== false) {
        if (!list.some(introducesFlow)) return
        scheduleScan(0)
        return
      }
      // 还在找聊天流：自己写的覆盖层变动不排扫描，否则会自己触发自己、空转成死循环。
      if (list.length > 0 && list.every(isOwnRecord)) return
      scheduleScan()
    }

    function bindBodyObserver() {
      if (state.bodyObserver !== null || typeof MutationObserver !== 'function' || !document.body) return
      state.bodyObserver = new MutationObserver(onBodyMutation)
      state.bodyObserver.observe(document.body, { childList: true, subtree: true })
    }

    function bindFlow(flow) {
      if (state.flowEl === flow && state.flowObserver !== null) return
      if (state.flowObserver !== null) state.flowObserver.disconnect()
      state.flowEl = flow
      // 换了聊天流就重找滚动容器：弧线要裁在正文被裁的那条线上。
      state.scrollEl = findScrollContainer()
      if (typeof MutationObserver !== 'function') return
      // 流式吐字时每条变动都命中：真扫描由 scheduleScan 的最小间隔压住，
      // 结构没变时扫描只量坐标。
      state.flowObserver = new MutationObserver(() => scheduleScan())
      state.flowObserver.observe(flow, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['hidden', 'data-chat-motion'],
      })
    }

    function bindWindowEvents() {
      if (state.onScroll !== null) return
      // 滚动零延迟：只按缓存重算弧线与徽标坐标（走 rAF 逐帧），绝不排扫描。
      state.onScroll = () => scheduleScrollFrame()
      state.onResize = () => scheduleScan(0)
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('scroll', state.onScroll, true)
        window.addEventListener('resize', state.onResize, false)
      }
    }

    function unbindWindowEvents() {
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        if (state.onScroll !== null) window.removeEventListener('scroll', state.onScroll, true)
        if (state.onResize !== null) window.removeEventListener('resize', state.onResize, false)
      }
      state.onScroll = null
      state.onResize = null
    }

    function startEngine() {
      if (state.engineOn || state.disposed) return
      if (typeof document === 'undefined') return
      state.engineOn = true
      state.structureSignature = null
      ensureStyles()
      ensureOverlay()
      bindBodyObserver()
      bindWindowEvents()
      if (!document.body) {
        if (state.retryTimer === null) {
          state.retryTimer = setTimeout(() => {
            state.retryTimer = null
            if (!state.engineOn) return
            ensureStyles()
            ensureOverlay()
            bindBodyObserver()
            bindWindowEvents()
            scan()
          }, 120)
        }
        return
      }
      scan()
    }

    function stopEngine() {
      state.engineOn = false
      state.structureSignature = null
      if (state.scanTimer !== null) {
        clearTimeout(state.scanTimer)
        state.scanTimer = null
      }
      if (state.scanRaf !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.scanRaf)
        else clearTimeout(state.scanRaf)
        state.scanRaf = null
      }
      if (state.positionRaf !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.positionRaf)
        else clearTimeout(state.positionRaf)
        state.positionRaf = null
      }
      if (state.retryTimer !== null) {
        clearTimeout(state.retryTimer)
        state.retryTimer = null
      }
      if (state.flowObserver !== null) {
        state.flowObserver.disconnect()
        state.flowObserver = null
      }
      if (state.bodyObserver !== null) {
        state.bodyObserver.disconnect()
        state.bodyObserver = null
      }
      state.flowEl = null
      state.scrollEl = null
      unbindWindowEvents()
      clearAnswerMarks()
      reconcileMarkers([])
      removeOverlay()
    }

    function applyConfig(next) {
      const previous = state.cfg
      state.cfg = next
      if (!next.enabled) {
        stopEngine()
        return
      }
      if (!state.engineOn) {
        startEngine()
        return
      }
      if (!sameConfig(previous, next)) {
        if (!next.showBadges || !next.showNumbers) {
          // 配置切换后只保留仍然需要的标记；整表重扫最稳。
          reconcileMarkers([])
        }
        scheduleScan(0)
      }
    }

    // ================================================================
    // 配置表单（客户端只读面）
    // ================================================================

    function readSnapshot(form) {
      if (form === null || form === undefined || typeof form.getSnapshot !== 'function') return null
      try {
        return form.getSnapshot()
      } catch {
        return null
      }
    }

    function findForm(forms) {
      if (forms === null || forms === undefined || typeof forms.get !== 'function') return null
      for (const id of [PKG, 'chat-gutter']) {
        try {
          const form = forms.get(id)
          if (form !== null && form !== undefined) return form
        } catch {
          // 命名空间尚未提供时 get 可能抛错，继续找
        }
      }
      try {
        const describe = typeof forms.describe === 'function' ? forms.describe() : null
        const snapshot = describe !== null && typeof describe.getSnapshot === 'function' ? describe.getSnapshot() : null
        const namespaces = snapshot && snapshot.view && Array.isArray(snapshot.view.namespaces) ? snapshot.view.namespaces : []
        for (const row of namespaces) {
          const ns = row && typeof row.ns === 'string' ? row.ns : ''
          if (ns === PKG || ns === 'chat-gutter' || ns.slice(-12) === '/chat-gutter' || ns.slice(-16) === '-dsh-chat-gutter') {
            const form = forms.get(ns)
            if (form !== null && form !== undefined) return form
          }
        }
      } catch {
        // describe 面不可用时保持默认配置
      }
      return null
    }

    function subscribeForm(form) {
      if (state.form === form) return
      if (typeof state.formUnsub === 'function') state.formUnsub()
      state.formUnsub = null
      state.form = form
      const update = () => {
        const snapshot = readSnapshot(form)
        if (snapshot === null || snapshot.status !== 'ready') return
        applyConfig(normalizeConfig(snapshot.value))
      }
      if (typeof form.subscribe === 'function') {
        try {
          state.formUnsub = form.subscribe(update)
        } catch {
          state.formUnsub = null
        }
      }
      update()
    }

    function bindForms(forms) {
      if (state.disposed) return
      const form = findForm(forms)
      if (form !== null) {
        subscribeForm(form)
        return
      }
      if (state.formWaitTried) return
      state.formWaitTried = true
      if (typeof forms.whileServed === 'function') {
        try {
          state.formWaitDispose = forms.whileServed([PKG], () => bindForms(forms))
        } catch {
          state.formWaitDispose = null
        }
      }
    }

    function disposeForms() {
      if (typeof state.formUnsub === 'function') state.formUnsub()
      state.formUnsub = null
      state.form = null
      if (typeof state.formWaitDispose === 'function') state.formWaitDispose()
      else if (state.formWaitDispose !== null && typeof state.formWaitDispose.dispose === 'function') state.formWaitDispose.dispose()
      state.formWaitDispose = null
    }

    function removeNav() {
      if (typeof state.navUnbind === 'function') state.navUnbind()
      state.navUnbind = null
      if (state.navPanel !== null && state.navPanel !== undefined) {
        try {
          state.navPanel.remove()
        } catch {
          // 已经跟着父节点一起没了
        }
      }
      state.navPanel = null
    }

    function dispose() {
      state.disposed = true
      disposeForms()
      stopEngine()
      removeNav()
      removeStyles()
    }

    // ================================================================
    // 配置页：行详情页的 plugins.row.config 席位
    // ================================================================

    const PAGE_STYLE = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '2px 0 6px' },
      row: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '20px' },
      text: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
      label: { fontSize: '13px', lineHeight: '18px', color: 'var(--dsw-alias-label-primary, #1f2328)' },
      hint: { margin: 0, fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' },
      footer: { display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '4px' },
      button: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-bg-layer-2, #f3f4f6)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        borderRadius: '7px',
        padding: '5px 14px',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      status: { fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)' },
      error: { fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-state-error-primary, #d92d20)' },
      selectRow: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      option: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #6b7280)',
        borderRadius: '6px',
        padding: '3px 9px',
        fontSize: '12px',
        lineHeight: '16px',
        cursor: 'pointer',
      },
      optionActive: {
        border: '1px solid var(--dsw-alias-brand-primary, #3b82f6)',
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 12%, transparent)',
        color: 'var(--dsw-alias-label-primary, #1f2328)',
        borderRadius: '6px',
        padding: '3px 9px',
        fontSize: '12px',
        lineHeight: '16px',
        cursor: 'pointer',
      },
      notice: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8b93a1)', margin: 0 },
    }

    function Switch(props) {
      const checked = props.checked === true
      const disabled = props.disabled === true
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        disabled,
        onClick: () => {
          if (!disabled && typeof props.onChange === 'function') props.onChange(!checked)
        },
        style: {
          flex: 'none',
          width: '36px',
          height: '20px',
          borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
          background: checked
            ? 'var(--dsw-alias-brand-primary, #3b82f6)'
            : 'var(--dsw-alias-bg-layer-2, #e5e7eb)',
          position: 'relative',
          padding: 0,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          transition: 'background .15s',
        },
      }, h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          top: '1px',
          left: checked ? '17px' : '1px',
          width: '16px',
          height: '16px',
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,.25)',
          transition: 'left .15s',
        },
      }))
    }

    /**
     * 行详情页传进来的 form 是 `{ state, mutate }`（按包名#行 id 配置命名空间），
     * 不是 configForms 的活控制器；state 就是一次 form.getSnapshot() 的值。
     * 为了兼容直接传控制器的宿主，这里两种形状都认。
     */
    function readPageSnapshot(form) {
      if (form === null || form === undefined || typeof form !== 'object') return null
      if (form.state !== null && typeof form.state === 'object') return form.state
      return readSnapshot(form)
    }

    function diffOps(base, current) {
      const ops = []
      for (const field of ['enabled', 'showNumbers', 'showBadges', 'answerMark']) {
        if (base[field] !== current[field]) ops.push({ op: 'set', path: [field], value: current[field] })
      }
      return ops
    }

    function ConfigPage(props) {
      const form = props && props.form ? props.form : null
      const view = props && props.view ? props.view : 'page'
      const snapshot = readPageSnapshot(form)
      const [draft, setDraft] = React.useState(null)
      const [committed, setCommitted] = React.useState(null)
      const [saveState, setSaveState] = React.useState({ kind: 'idle' })
      const ready = snapshot !== null && snapshot !== undefined && snapshot.status === 'ready'
      const writable = ready && snapshot.writable !== false
      const base = committed !== null
        ? committed
        : ready
          ? normalizeConfig(snapshot.value)
          : { ...DEFAULT_CONFIG }
      const revision = snapshot && snapshot.revision !== undefined ? snapshot.revision : null

      React.useEffect(() => {
        setDraft(null)
        setCommitted(null)
      }, [revision, ready])

      if (view === 'summary') {
        if (form === null) return h('span', { style: PAGE_STYLE.notice }, '编号、徽标与回答起点高亮')
        if (!ready) return h('span', { style: PAGE_STYLE.notice }, '配置尚未就绪')
        return h('span', { style: PAGE_STYLE.notice }, summaryText(base))
      }

      if (form === null) {
        return h('p', { style: PAGE_STYLE.notice }, '宿主没有向配置页提供本插件的表单；标识带按默认配置运行。')
      }
      if (!ready) {
        const text = snapshot && snapshot.status === 'unavailable'
          ? '宿主尚未提供 dsh-chat-gutter 配置命名空间，当前按默认配置运行。'
          : '正在读取配置…'
        return h('p', { style: PAGE_STYLE.notice }, text)
      }

      const values = draft === null ? base : draft
      const dirty = diffOps(base, values).length > 0
      const busy = saveState.kind === 'saving'

      const update = (patch) => {
        setDraft({ ...values, ...patch })
        if (saveState.kind === 'saved' || saveState.kind === 'error') setSaveState({ kind: 'idle' })
      }

      const save = () => {
        if (!writable || busy || !dirty) return
        const ops = diffOps(base, values)
        if (ops.length === 0) return
        setSaveState({ kind: 'saving' })
        let result
        try {
          // 行详情页给的是 { state, mutate }；不传 expectedRevision，让控制器用
          // 自己的最新 revision，避免页面未及时刷新时第二次保存撞上旧版本。
          result = form.mutate(ops)
        } catch (error) {
          setSaveState({ kind: 'error', message: error && error.message ? error.message : String(error) })
          return
        }
        Promise.resolve(result).then((accepted) => {
          if (accepted === true) {
            setCommitted(values)
            setDraft(values)
            setSaveState({ kind: 'saved' })
          }
          else setSaveState({ kind: 'error', message: '宿主未接受保存（命名空间未提供或版本已变化），请重新打开本页再试。' })
        }, (error) => {
          setSaveState({ kind: 'error', message: error && error.message ? error.message : String(error) })
        })
      }

      const modeOptions = [['off', '关闭'], ['tools', '仅干完活后'], ['always', '总是']]

      let statusText = ''
      if (!writable) statusText = '当前配置只读。'
      else if (saveState.kind === 'saving') statusText = '保存中…'
      else if (saveState.kind === 'saved') statusText = '已保存，立即生效。'
      else if (saveState.kind === 'error') statusText = saveState.message
      else if (dirty) statusText = '有未保存的修改。'
      else statusText = '修改后点保存生效。'

      return h('div', { style: PAGE_STYLE.wrap },
        h('div', { style: PAGE_STYLE.row },
          h('div', { style: PAGE_STYLE.text },
            h('span', { style: PAGE_STYLE.label }, '启用左侧标识带'),
            h('p', { style: PAGE_STYLE.hint }, '关掉后编号、徽标、回答高亮全部消失，不改动聊天内容。'),
          ),
          h(Switch, { checked: values.enabled, disabled: !writable || busy, onChange: (value) => update({ enabled: value }) }),
        ),
        h('div', { style: PAGE_STYLE.row },
          h('div', { style: PAGE_STYLE.text },
            h('span', { style: PAGE_STYLE.label }, '回合编号路标'),
            h('p', { style: PAGE_STYLE.hint }, '每个 AI 回合左侧一枚 #1 #2…，细线串成时间线。'),
          ),
          h(Switch, { checked: values.showNumbers, disabled: !writable || busy, onChange: (value) => update({ showNumbers: value }) }),
        ),
        h('div', { style: PAGE_STYLE.row },
          h('div', { style: PAGE_STYLE.text },
            h('span', { style: PAGE_STYLE.label }, '行级徽标'),
            h('p', { style: PAGE_STYLE.hint }, '工具、命令、思考、上下文压缩行与待答提问卡左侧的小徽标。'),
          ),
          h(Switch, { checked: values.showBadges, disabled: !writable || busy, onChange: (value) => update({ showBadges: value }) }),
        ),
        h('div', { style: PAGE_STYLE.row },
          h('div', { style: PAGE_STYLE.text },
            h('span', { style: PAGE_STYLE.label }, '回答起点高亮'),
            h('p', { style: PAGE_STYLE.hint }, '给第一段正文加琥珀色高亮条，左侧配 ▶答。'),
          ),
          h('div', { style: PAGE_STYLE.selectRow }, modeOptions.map(([value, label]) =>
            h('button', {
              key: value,
              type: 'button',
              disabled: !writable || busy,
              'aria-pressed': values.answerMark === value ? 'true' : 'false',
              onClick: () => update({ answerMark: value }),
              style: values.answerMark === value ? PAGE_STYLE.optionActive : PAGE_STYLE.option,
            }, label),
          )),
        ),
        h('div', { style: PAGE_STYLE.footer },
          h('button', {
            type: 'button',
            disabled: !writable || busy || !dirty,
            onClick: save,
            style: !writable || busy || !dirty ? { ...PAGE_STYLE.button, ...PAGE_STYLE.buttonDisabled } : PAGE_STYLE.button,
          }, busy ? '保存中…' : '保存'),
          h('span', { style: saveState.kind === 'error' ? PAGE_STYLE.error : PAGE_STYLE.status }, statusText),
        ),
      )
    }

    // ================================================================
    // apply
    // ================================================================

    /**
     * 把一处槽位注册包进 ctx.effect。
     * 宿主有 effect 就交给它托管生命周期；没有就直接跑（回落）。
     * 注册抛错时先打出这一处席位的实参，再原样抛给上层日志。
     */
    function registerSlot(ctx, label, options, register) {
      const run = () => {
        try {
          return register()
        } catch (error) {
          console.error(LOG, label + '注册失败', options, error)
          throw error
        }
      }
      if (ctx && typeof ctx.effect === 'function') return ctx.effect(run, PKG + ': ' + label)
      return run()
    }

    function apply(ctx) {
      try {
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            if (state.cfg.enabled) startEngine()
            return () => stopEngine()
          }, 'dsh-chat-gutter: 标识带')
        } else if (state.cfg.enabled) {
          startEngine()
        }

        // 两处席位注册都走 ctx.effect：和引擎同一条激活链路（与能正常冷启动的 dsh-prompt 同形），
        // 激活时机、热重载与卸载都由宿主收回。注册失败时把实参打进日志再原样抛，
        // 下次重启若仍失败，日志里直接有 name/id/key/order 可以核对。
        const configSlot = { name: 'plugins.row.config', key: PKG + '#' + PKG, order: 10 }
        const navSlot = { name: 'conversation.input.left', id: PKG + '-quick-nav', key: PKG + '#quick-nav', order: 20 }

        if (ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
          try {
            registerSlot(ctx, '配置页席位', configSlot, () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register(configSlot, ConfigPage)))
          } catch (error) {
            console.error(LOG, '配置页席位注册失败', error)
          }

          try {
            // 与 dsh-prompt 入口按钮同一排：输入区左侧插槽。
            // list 型插槽要求 options.id（真机报错「requires options.id」），key 不够。
            registerSlot(ctx, '快速移动席位', navSlot, () => ctx.slots.inject('conversation.input.left', () => ctx.slots.register(navSlot, QuickNav)))
          } catch (error) {
            console.error(LOG, '快速移动席位注册失败', error)
          }
        } else {
          console.warn(LOG, '没有 slots 服务，席位注册跳过')
        }

        try {
          if (ctx && typeof ctx.inject === 'function') {
            ctx.inject(['configForms'], (fctx) => {
              try {
                bindForms(fctx && fctx.configForms)
              } catch (error) {
                console.warn(LOG, '读取配置失败', error)
              }
            })
          } else if (ctx && ctx.configForms) {
            bindForms(ctx.configForms)
          }
        } catch (error) {
          console.warn(LOG, 'configForms 接入失败', error)
        }

        console.info(LOG, '已加载（双侧标识带 v0.1）')
      } catch (error) {
        console.error(LOG, 'apply 失败', error)
      }
      return () => dispose()
    }

    return {
      name: PKG,
      inject: ['slots'],
      apply,
      __test: {
        DEFAULT_CONFIG,
        unwrap,
        normalizeConfig,
        badgeForKind,
        planAnswerMarks,
        layoutMarkers,
        gutterLeft,
        gutterRight,
        processBadgeText,
        countTools,
        countThinkRows,
        panelTypeOfKind,
        questionSeatType,
        excerptText,
        mergeAnswerRuns,
        collectPanelEntries,
        findLoadEarlier,
        jumpToEntry,
        processBadgeMarkers,
        mountNav,
        stateForTest: () => state,
        scanStats: () => ({ full: state.scanFull, cheap: state.scanCheap }),
        structureSignature,
        summaryText,
        readPageSnapshot,
        ConfigPage,
        styleSheet: CSS,
      },
    }
  },
})
