// 安装/回滚辅助：对桌面端 GUI 端口的 dsh-market 接口发请求（只走 127.0.0.1 回环）。
// 用法：
//   node tools/toggle.mjs on     --port 2058
//   node tools/toggle.mjs off    --port 2058
//   node tools/toggle.mjs status --port 2058
import http from 'node:http'

const action = process.argv[2] || 'status'
const portIndex = process.argv.indexOf('--port')
const port = portIndex > -1 ? Number(process.argv[portIndex + 1]) : 2058
const name = 'dsh-chat-gutter'

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === null || body === undefined ? null : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: data === null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text }))
    })
    req.on('error', reject)
    if (data !== null) req.write(data)
    req.end()
  })
}

const body = action === 'status' ? null : { name, enabled: action === 'on' }
const result = await request(body === null ? 'GET' : 'POST', `/dsh-market/${body === null ? 'status' : 'toggle'}`, body)
console.log('HTTP', result.status)
try {
  console.log(JSON.stringify(JSON.parse(result.body), null, 2))
} catch {
  console.log(result.body.slice(0, 2000))
}
