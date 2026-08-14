/** SVG 单调三次插值：平滑折线且不在相邻数据点范围外产生过冲。 */
export function smoothLinePath(points: ReadonlyArray<{ x: number; y: number }>): string {
  if (!points.length) return ''
  if (points.length === 1) return `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`

  // 单调插值要求 x 严格递增；异常数据退回直线，避免生成无效控制点。
  if (points.some((point, index) => index > 0 && point.x <= points[index - 1].x)) {
    return points
      .map((point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`
      )
      .join(' ')
  }

  const slopes = points.slice(1).map((point, index) => {
    const previous = points[index]
    return (point.y - previous.y) / (point.x - previous.x)
  })
  const tangents = new Array<number>(points.length)
  tangents[0] = slopes[0]
  tangents[tangents.length - 1] = slopes.at(-1)!

  // 加权调和平均（PCHIP）：相邻斜率反向时切线归零，从而不越过局部极值。
  for (let i = 1; i < points.length - 1; i++) {
    const before = slopes[i - 1]
    const after = slopes[i]
    if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) {
      tangents[i] = 0
      continue
    }
    const beforeWidth = points[i].x - points[i - 1].x
    const afterWidth = points[i + 1].x - points[i].x
    const weight1 = 2 * afterWidth + beforeWidth
    const weight2 = afterWidth + 2 * beforeWidth
    tangents[i] = (weight1 + weight2) / (weight1 / before + weight2 / after)
  }

  const path = [`M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`]
  for (let i = 0; i < points.length - 1; i++) {
    const current = points[i]
    const next = points[i + 1]
    const third = (next.x - current.x) / 3
    path.push(
      `C${(current.x + third).toFixed(2)},${(current.y + tangents[i] * third).toFixed(2)} ` +
        `${(next.x - third).toFixed(2)},${(next.y - tangents[i + 1] * third).toFixed(2)} ` +
        `${next.x.toFixed(2)},${next.y.toFixed(2)}`
    )
  }
  return path.join(' ')
}
