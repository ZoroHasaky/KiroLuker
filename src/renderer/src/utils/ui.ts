// 界面交互的通用套路：结果提示、复制、危险操作确认、弹层容器
import { Modal, message } from 'ant-design-vue'
import type { VNode } from 'vue'

/** store 里各操作统一返回的结果形状 */
export interface ActionResult {
  ok: boolean
  error?: string
}

/**
 * 统一处理「成功提示 / 失败提示」。
 * failPrefix 为空时直接展示后端错误原文，保持各调用点原有文案。
 */
export function notifyResult(
  res: ActionResult,
  options: { success: string; failPrefix?: string }
): boolean {
  if (!res.ok) {
    const { failPrefix } = options
    message.error(failPrefix ? `${failPrefix}：${res.error}` : String(res.error))
    return false
  }
  message.success(options.success)
  return true
}

/** 复制到剪贴板并提示 */
export function copyText(text: string, successMessage: string): void {
  window.api.writeClipboard(text)
  message.success(successMessage)
}

/**
 * 危险操作二次确认。默认红色描边确认按钮，
 * 传 okButtonProps 时以它为准（例如需要实心红按钮的场景）。
 */
export function confirmDanger(options: {
  title: string
  content?: string | VNode
  okText: string
  onOk: () => void | Promise<unknown>
  okButtonProps?: { type?: 'primary'; danger?: boolean }
}): void {
  const { okButtonProps, ...rest } = options
  Modal.confirm({
    cancelText: '取消',
    ...(okButtonProps ? { okButtonProps } : { okType: 'danger' }),
    ...rest
  })
}

/** 弹层挂到 body，避免被顶栏或滚动容器裁剪 */
export const bodyPopupContainer = (): HTMLElement => document.body
