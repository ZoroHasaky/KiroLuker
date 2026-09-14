// 两跳代理链的回环集成测试：可信代理 → 池 IP 代理 → 目标站点。
// 全部走 127.0.0.1 本地起的真实 TCP 服务（同 http-stream.test.mjs 的范式），
// 验证 net.ts 的 chainedConnect + httpRequest(proxyUrl, proxyViaUrl) 端到端可用。
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { httpRequest } from '../src/main/net.ts'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address())
    })
  })
}

/** 极简 HTTP CONNECT 代理：记录 CONNECT 目标，回 200 后字节透传 */
function connectProxy(log) {
  return net.createServer((client) => {
    let header = Buffer.alloc(0)
    const onData = (chunk) => {
      header = Buffer.concat([header, chunk])
      const end = header.indexOf('\r\n\r\n')
      if (end === -1) return
      client.removeListener('data', onData)
      const target = header.subarray(0, end).toString('latin1').split(' ')[1] || ''
      log.push(target)
      const separator = target.lastIndexOf(':')
      const upstream = net.connect(Number(target.slice(separator + 1)), target.slice(0, separator))
      const destroy = () => {
        client.destroy()
        upstream.destroy()
      }
      upstream.on('error', destroy)
      client.on('error', destroy)
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        client.pipe(upstream)
        upstream.pipe(client)
      })
    }
    client.on('data', onData)
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    for (const socket of server?.sockets ?? []) socket.destroy()
  })
}

test('httpRequest walks the two-hop chain: trusted proxy → pool proxy → target', async () => {
  const trustedLog = []
  const poolLog = []
  const webHits = []
  const web = http.createServer((req, res) => {
    webHits.push(req.url)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('chain-ok')
  })
  const trusted = connectProxy(trustedLog)
  const pool = connectProxy(poolLog)
  await listen(web)
  await listen(trusted)
  await listen(pool)
  try {
    const response = await httpRequest(`http://127.0.0.1:${web.address().port}/pool-chain`, {
      proxyUrl: `http://127.0.0.1:${pool.address().port}`,
      proxyViaUrl: `http://127.0.0.1:${trusted.address().port}`
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'chain-ok')
    assert.deepEqual(webHits, ['/pool-chain'])
    // 可信代理只看到「到池代理」的 CONNECT，池代理只看到「到目标」的 CONNECT
    assert.deepEqual(trustedLog, [`127.0.0.1:${pool.address().port}`])
    assert.deepEqual(poolLog, [`127.0.0.1:${web.address().port}`])
  } finally {
    await closeServer(trusted)
    await closeServer(pool)
    await closeServer(web)
  }
})

test('httpRequest surfaces a rejected hop instead of falling back to direct', async () => {
  const poolLog = []
  const pool = connectProxy(poolLog)
  await listen(pool)
  // 「可信代理」对任何 CONNECT 都回 403
  const trusted = net.createServer((client) => {
    client.once('data', () => client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'))
  })
  await listen(trusted)
  try {
    await assert.rejects(
      httpRequest('http://127.0.0.1:1/never', {
        proxyUrl: `http://127.0.0.1:${pool.address().port}`,
        proxyViaUrl: `http://127.0.0.1:${trusted.address().port}`,
        timeoutMs: 5_000
      })
    )
    assert.deepEqual(poolLog, [], '可信代理拒绝时流量不得绕过直达池代理')
  } finally {
    await closeServer(trusted)
    await closeServer(pool)
  }
})
