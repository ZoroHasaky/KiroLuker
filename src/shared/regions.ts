// ============================================
// AWS 区域列表（主进程 / 渲染进程共享）
// ============================================

export interface RegionOption {
  value: string
  label: string
}

export interface RegionGroup {
  label: string
  options: RegionOption[]
}

/** 按地理分组的完整区域列表，供区域选择器使用 */
export const AWS_REGION_GROUPS: RegionGroup[] = [
  {
    label: 'US',
    options: [
      { value: 'us-east-1', label: 'us-east-1 (N. Virginia)' },
      { value: 'us-east-2', label: 'us-east-2 (Ohio)' },
      { value: 'us-west-1', label: 'us-west-1 (N. California)' },
      { value: 'us-west-2', label: 'us-west-2 (Oregon)' }
    ]
  },
  {
    label: 'Europe',
    options: [
      { value: 'eu-west-1', label: 'eu-west-1 (Ireland)' },
      { value: 'eu-west-2', label: 'eu-west-2 (London)' },
      { value: 'eu-west-3', label: 'eu-west-3 (Paris)' },
      { value: 'eu-central-1', label: 'eu-central-1 (Frankfurt)' },
      { value: 'eu-north-1', label: 'eu-north-1 (Stockholm)' },
      { value: 'eu-south-1', label: 'eu-south-1 (Milan)' }
    ]
  },
  {
    label: 'Asia Pacific',
    options: [
      { value: 'ap-northeast-1', label: 'ap-northeast-1 (Tokyo)' },
      { value: 'ap-northeast-2', label: 'ap-northeast-2 (Seoul)' },
      { value: 'ap-northeast-3', label: 'ap-northeast-3 (Osaka)' },
      { value: 'ap-southeast-1', label: 'ap-southeast-1 (Singapore)' },
      { value: 'ap-southeast-2', label: 'ap-southeast-2 (Sydney)' },
      { value: 'ap-south-1', label: 'ap-south-1 (Mumbai)' },
      { value: 'ap-east-1', label: 'ap-east-1 (Hong Kong)' }
    ]
  },
  {
    label: 'Other',
    options: [
      { value: 'ca-central-1', label: 'ca-central-1 (Canada)' },
      { value: 'sa-east-1', label: 'sa-east-1 (São Paulo)' },
      { value: 'me-south-1', label: 'me-south-1 (Bahrain)' },
      { value: 'af-south-1', label: 'af-south-1 (Cape Town)' }
    ]
  }
]

/** 扁平的区域列表，供下面两个查询函数使用 */
const AWS_REGIONS: RegionOption[] = AWS_REGION_GROUPS.flatMap((group) => group.options)

export const DEFAULT_REGION = 'us-east-1'

/** 是否为列表内的已知区域（否则视为自定义区域） */
export function isKnownRegion(value?: string): boolean {
  return !!value && AWS_REGIONS.some((item) => item.value === value)
}

/** 带地名的展示文案，未知区域原样返回 */
export function regionLabel(value?: string): string {
  if (!value) return '-'
  return AWS_REGIONS.find((item) => item.value === value)?.label ?? `${value}（自定义）`
}
