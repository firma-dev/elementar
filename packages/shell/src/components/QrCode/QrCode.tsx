import type { JSX } from 'preact'
import { useMemo } from 'preact/hooks'
import { cx } from '@elementar/ui'
import type { Base } from '@elementar/ui'
import { QR_ECC, QR_QUIET_MODULES, QR_SIZE_PX, qrMatrix, qrPath } from '../../qr.js'
import type { QrEcc } from '../../qr.js'

export interface QrCodeProps extends Base {
  value: string
  /** 232×232 по умолчанию (§12.8). */
  size?: number
  ecc?: QrEcc
  quiet?: number
  /** Текст для скринридера; пустой — картинка декоративная. */
  label?: string
}

/** QR считается локально: ссылка с фрагментом никуда не уходит. */
export function QrCode({
  value,
  size = QR_SIZE_PX,
  ecc = QR_ECC,
  quiet = QR_QUIET_MODULES,
  label,
  class: cls,
  ...rest
}: QrCodeProps): JSX.Element {
  const matrix = useMemo(() => qrMatrix(value, ecc), [value, ecc])
  const path = useMemo(() => qrPath(matrix), [matrix])
  const side = matrix.size + quiet * 2
  return (
    <svg
      {...rest}
      class={cx('e-qr', cls)}
      width={size}
      height={size}
      viewBox={`0 0 ${side} ${side}`}
      shape-rendering="crispEdges"
      role="img"
      aria-label={label}
      aria-hidden={label === undefined ? 'true' : undefined}
    >
      <rect width={side} height={side} class="e-qr__field" />
      <g transform={`translate(${quiet} ${quiet})`} class="e-qr__modules">
        <path d={path} />
      </g>
    </svg>
  )
}
