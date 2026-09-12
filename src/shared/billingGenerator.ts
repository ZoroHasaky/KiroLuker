import { pinyin } from 'pinyin-pro'

export interface LocalBillingAddress {
  province: string
  city: string
  district: string
  pinyinCity: string
  pinyinDistrict: string
  addressLine1: string
  postalCode: string
}

/**
 * 省、市、区保持为同一条真实行政区组合，避免随机拼接出跨区域地址。
 * 省份仍返回中文，支付表单会根据省份名称映射下拉选项；城市和地区由调用方展示为拼音。
 */
export const BILLING_REGIONS = [
  { province: '北京市', city: '北京市', district: '海淀区' },
  { province: '上海市', city: '上海市', district: '浦东新区' },
  { province: '广东省', city: '深圳市', district: '南山区' },
  { province: '广东省', city: '广州市', district: '天河区' },
  { province: '浙江省', city: '杭州市', district: '拱墅区' },
  { province: '江苏省', city: '南京市', district: '鼓楼区' },
  { province: '福建省', city: '福州市', district: '鼓楼区' },
  { province: '山东省', city: '青岛市', district: '市南区' },
  { province: '湖北省', city: '武汉市', district: '武昌区' },
  { province: '四川省', city: '成都市', district: '武侯区' },
  { province: '云南省', city: '昆明市', district: '官渡区' },
  { province: '陕西省', city: '西安市', district: '雁塔区' },
  { province: '辽宁省', city: '沈阳市', district: '和平区' },
  { province: '湖南省', city: '长沙市', district: '岳麓区' },
  { province: '安徽省', city: '合肥市', district: '蜀山区' }
] as const

const STREET_NAMES = [
  '龙湖天路', '长安路', '春熙路', '文三路', '软件园路', '滨江大道', '解放大道',
  '人民路', '和平路', '建设路', '学府路', '中山路', '环城路', '文化路', '湖滨路'
] as const

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

function randomNumber(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function titleCase(value: string): string {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}` : ''
}

function romanize(value: string): string {
  return pinyin(value, { toneType: 'none', type: 'array' })
    .join('')
    .replace(/[^a-zA-Z]/g, '')
}

/** 将中文道路/行政区名称转换为“主体连写、后缀独立成词”的拼音格式。 */
export function billingPinyin(value: string): string {
  const clean = value.trim().replace(/[，,；;、]/g, ' ')
  if (!clean) return ''
  const pieces = clean.match(/[\u4e00-\u9fff]+|\d+|[A-Za-z]+/g) ?? []
  const suffixes = ['特别行政区', '自治区', '省', '市', '区', '县', '路', '街', '道', '巷', '号']
  const words: string[] = []
  for (const piece of pieces) {
    if (/^\d+$/.test(piece)) {
      words.push(piece)
      continue
    }
    if (/^[A-Za-z]+$/.test(piece)) {
      words.push(titleCase(piece))
      continue
    }
    let remaining = piece
    const trailing: string[] = []
    while (remaining) {
      const suffix = suffixes.find((candidate) => remaining.endsWith(candidate))
      if (!suffix) break
      remaining = remaining.slice(0, -suffix.length)
      trailing.unshift(suffix)
    }
    if (remaining) words.push(titleCase(romanize(remaining)))
    for (const suffix of trailing) words.push(titleCase(romanize(suffix)))
  }
  return words.filter(Boolean).join(' ')
}

export function createLocalBillingAddress(): LocalBillingAddress {
  const region = randomItem(BILLING_REGIONS)
  const road = randomItem(STREET_NAMES)
  const addressLine1 = billingPinyin(`${road}${randomNumber(1, 999)}号`)
  const postalCode = String(randomNumber(100000, 999999))
  if (!/^\d{6}$/.test(postalCode)) throw new Error('本地账单邮编生成失败')
  return {
    ...region,
    pinyinCity: billingPinyin(region.city),
    pinyinDistrict: billingPinyin(region.district),
    addressLine1,
    postalCode
  }
}
