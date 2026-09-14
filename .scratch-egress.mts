// 实测：批量取 4 个池端点，逐个经两跳链查真实出口 IP，验证出口是否互不相同
import { ProxyAgent, request } from 'undici'
import { httpRequest } from './src/main/net.ts'
import { parsePoolEndpoints, poolProxyUrl } from './src/main/proxyPool.ts'

const API_BASE = 'https://white.novproxy.com/white/api?region=Random&num=4&time=10&format=1&type=txt'
const TRUSTED = 'http://127.0.0.1:7899'

// 1. 经可信代理批量取 4 个端点
const trusted = new ProxyAgent(TRUSTED)
const res = await request(API_BASE, { dispatcher: trusted, method: 'GET', headersTimeout: 15000, bodyTimeout: 15000 })
const chunks: Buffer[] = []
for await (const c of res.body) chunks.push(Buffer.from(c))
await trusted.close().catch(() => undefined)
const endpoints = parsePoolEndpoints(Buffer.concat(chunks).toString('utf8'))
console.log(`批量取得 ${endpoints.length} 个端点:`)
for (const e of endpoints) console.log('  ', poolProxyUrl(e))

// 2. 逐个经两跳链查真实出口 IP
const egressList: string[] = []
for (const endpoint of endpoints) {
  const proxy = poolProxyUrl(endpoint)
  try {
    const resp = await httpRequest('https://api.ipify.org/', {
      proxyUrl: proxy,
      proxyViaUrl: TRUSTED,
      timeoutMs: 25000
    })
    const ip = (await resp.text()).trim()
    egressList.push(ip)
    console.log(`${proxy} → 出口 ${ip}`)
  } catch (e) {
    let cause = (e as any)?.cause
    const detail = cause instanceof Error ? cause.message : (e as Error).message
    console.log(`${proxy} → FAILED: ${detail}`)
    egressList.push(`FAIL:${detail.slice(0, 40)}`)
  }
}

// 3. 汇总
const ok = egressList.filter((ip) => !ip.startsWith('FAIL:'))
const distinct = new Set(ok)
console.log(`\n结论: ${ok.length}/${endpoints.length} 个端点可用，真实出口去重后 ${distinct.size} 个`)
console.log(ok.length === distinct.length
  ? '出口互不相同 —— 每条链接确实是不同来源 IP'
  : `存在共享出口: ${[...distinct].map((ip) => `${ip} ×${ok.filter((x) => x === ip).length}`).join(', ')}`)
