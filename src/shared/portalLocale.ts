// 内置浏览器访问 Kiro 网页端时使用的地区
//
// 主进程按它设置 Chromium 区域与 Accept-Language，渲染层用同一份预设渲染下拉。
// 取值是标准 BCP 47 语言标签，用户可以直接填预设之外的任意地区，
// 因此这里只做规范化与派生，不做白名单校验。

/** 语言标签，如 zh-CN / en-US；不限定枚举，用户可自定义 */
export type PortalLocale = string

export const DEFAULT_PORTAL_LOCALE = 'zh-CN'

/** 下拉里代表「自定义」的哨兵值，不会被保存到设置里 */
export const PORTAL_LOCALE_CUSTOM = '__custom__'

/** 下拉预设：标签为「地区（语言标签）」，取值不限于此，用户可选自定义后手输 */
export const PORTAL_LOCALE_PRESETS: { value: string; label: string }[] = [
  { value: 'zh-CN', label: '中国大陆（zh-CN）' },
  { value: 'zh-HK', label: '中国香港特别行政区（zh-HK）' },
  { value: 'zh-TW', label: '中国台湾地区（zh-TW）' },
  { value: 'zh-MO', label: '中国澳门特别行政区（zh-MO）' },
  { value: 'zh-SG', label: '新加坡（zh-SG）' },
  { value: 'en-US', label: '美国（en-US）' },
  { value: 'en-GB', label: '英国（en-GB）' },
  { value: 'en-AU', label: '澳大利亚（en-AU）' },
  { value: 'en-CA', label: '加拿大（en-CA）' },
  { value: 'en-NZ', label: '新西兰（en-NZ）' },
  { value: 'en-IN', label: '印度（en-IN）' },
  { value: 'en-IE', label: '爱尔兰（en-IE）' },
  { value: 'de-DE', label: '德国（de-DE）' },
  { value: 'de-CH', label: '瑞士（de-CH）' },
  { value: 'fr-FR', label: '法国（fr-FR）' },
  { value: 'fr-CA', label: '加拿大（法语）（fr-CA）' },
  { value: 'it-IT', label: '意大利（it-IT）' },
  { value: 'es-ES', label: '西班牙（es-ES）' },
  { value: 'es-MX', label: '墨西哥（es-MX）' },
  { value: 'ru-RU', label: '俄罗斯（ru-RU）' },
  { value: 'ja-JP', label: '日本（ja-JP）' },
  { value: 'ko-KR', label: '韩国（ko-KR）' },
  { value: 'pt-BR', label: '巴西（pt-BR）' },
  { value: 'pt-PT', label: '葡萄牙（pt-PT）' },
  { value: 'nl-NL', label: '荷兰（nl-NL）' },
  { value: 'sv-SE', label: '瑞典（sv-SE）' },
  { value: 'nb-NO', label: '挪威（nb-NO）' },
  { value: 'da-DK', label: '丹麦（da-DK）' },
  { value: 'fi-FI', label: '芬兰（fi-FI）' },
  { value: 'pl-PL', label: '波兰（pl-PL）' },
  { value: 'cs-CZ', label: '捷克（cs-CZ）' },
  { value: 'hu-HU', label: '匈牙利（hu-HU）' },
  { value: 'ro-RO', label: '罗马尼亚（ro-RO）' },
  { value: 'el-GR', label: '希腊（el-GR）' },
  { value: 'tr-TR', label: '土耳其（tr-TR）' },
  { value: 'vi-VN', label: '越南（vi-VN）' },
  { value: 'th-TH', label: '泰国（th-TH）' },
  { value: 'id-ID', label: '印度尼西亚（id-ID）' },
  { value: 'ms-MY', label: '马来西亚（ms-MY）' },
  { value: 'ar-SA', label: '沙特阿拉伯（ar-SA）' },
  { value: 'ar-AE', label: '阿联酋（ar-AE）' },
  { value: 'bg-BG', label: '保加利亚（bg-BG）' },
  { value: 'hr-HR', label: '克罗地亚（hr-HR）' },
  { value: 'sk-SK', label: '斯洛伐克（sk-SK）' },
  { value: 'lt-LT', label: '立陶宛（lt-LT）' },
  { value: 'lv-LV', label: '拉脱维亚（lv-LV）' },
  // 爱沙尼亚的地区码是 EE，ET 是埃塞俄比亚的国家码
  { value: 'et-EE', label: '爱沙尼亚（et-EE）' },
  { value: 'fil-PH', label: '菲律宾（fil-PH）' },
  { value: 'uk-UA', label: '乌克兰（uk-UA）' },
  { value: 'af-ZA', label: '南非（af-ZA）' }
]

/** 判断某个取值是否落在预设里，界面据此决定下拉显示预设项还是「自定义」 */
export function isPresetPortalLocale(value?: string): boolean {
  return PORTAL_LOCALE_PRESETS.some((item) => item.value === value)
}

/**
 * 规范化用户输入的语言标签。
 *
 * 只保留字母数字与连字符：这个值会进 Chromium 命令行与请求头，
 * 放任空格或引号进去可能被上游拆错，甚至影响命令行解析。
 * 大小写按 BCP 47 惯例对齐（语言小写、地区大写），非法输入回落到默认地区。
 */
export function normalizePortalLocale(value?: string): string {
  const raw = String(value ?? '').trim()
  if (!raw) return DEFAULT_PORTAL_LOCALE

  // 下划线与空格先归一成连字符：en_US 是很常见的写法，直接剥掉会拼成 enus
  const cleaned = raw.replace(/[_\s]+/g, '-').replace(/[^a-zA-Z0-9-]/g, '')
  const [language, ...rest] = cleaned.split('-').filter(Boolean)
  if (!language) return DEFAULT_PORTAL_LOCALE

  const parts = [language.toLowerCase()]
  // 只规范首个子标签（地区/文字），其余原样保留，避免破坏 zh-Hant-HK 这类写法
  for (const [index, part] of rest.entries()) {
    parts.push(index === 0 && part.length === 2 ? part.toUpperCase() : part)
  }
  return parts.join('-')
}

/**
 * 由语言标签派生 Accept-Language。
 *
 * 真实浏览器会带 q 降级项，只发一个精确标签反而不像浏览器；
 * 同时补一条 en 兜底，避免小语种地区遇到未本地化的页面时拿不到可读内容。
 */
export function acceptLanguageFor(value?: string): string {
  const locale = normalizePortalLocale(value)
  const base = locale.split('-')[0]
  const items = [locale]
  if (base && base !== locale) items.push(`${base};q=0.9`)
  if (base !== 'en') items.push('en;q=0.8')
  return items.join(',')
}
