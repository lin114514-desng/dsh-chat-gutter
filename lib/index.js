/**
 * dsh-chat-gutter 宿主半边。
 *
 * 功能全部在浏览器半边（lib/client.js），这里只做两件事：
 *   1. 提供行配置 schema，让 Host 把 dsh-chat-gutter 命名空间提供给配置页；
 *   2. 让 Loader 有一条可加载的宿主入口（cordis.patch.yml 的 insert 行）。
 *
 * schemastery 解析不到时退回 undefined：行仍能挂载，浏览器半边按内置默认值运行。
 */
export const name = 'dsh-chat-gutter'

function live(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

let Schema = null
try {
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  Schema = null
}

export const Config = Schema === null
  ? undefined
  : Schema.object({
    enabled: live(Schema.boolean().default(true)),
    showNumbers: live(Schema.boolean().default(true)),
    showBadges: live(Schema.boolean().default(true)),
    answerMark: live(Schema.string().default('tools')),
  })

export function apply() {
  // 宿主侧无事可做
}
