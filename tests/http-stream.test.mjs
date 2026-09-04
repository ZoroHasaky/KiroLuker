import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { httpStream } from '../src/main/net.ts'

async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('流式响应在收到响应头后仍可通过外部 signal 取消', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.write('first')
      const timer = setInterval(() => response.write('next'), 20)
      response.on('close', () => clearInterval(timer))
    },
    async (url) => {
      const controller = new AbortController()
      const response = await httpStream(url, { method: 'GET', signal: controller.signal })
      const reader = response.body.getReader()
      const first = await reader.read()
      assert.equal(Buffer.from(first.value).toString(), 'first')
      controller.abort(new Error('test cancel'))
      await assert.rejects(reader.read(), /test cancel|abort/i)
    }
  )
})

test('流式错误响应仍可读取文本正文', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('bad request')
    },
    async (url) => {
      const response = await httpStream(url, { method: 'GET' })
      assert.equal(response.status, 400)
      assert.equal(await response.text(), 'bad request')
    }
  )
})
