// @elementar/ui — дизайн-система. Не знает про документы: компоненты, которым нужны
// docId, Proposal, ProviderConfig, живут в @elementar/shell (§11.9).
// Стили подключаются отдельно: import '@elementar/ui/styles.css'.

export type { Base, Slot, Tone } from './types.js'
export {
  bp,
  canvas,
  duration,
  qr,
  themeColor,
  SKELETON_DELAY_MS,
  THEME_STORAGE_KEY,
} from './tokens.js'
export type { Breakpoint, ThemeName, ThemeSetting } from './tokens.js'

export { cx } from './utils/cx.js'
export type { ClassValue } from './utils/cx.js'
export { focusableWithin, hasFinePointer, withWillChange } from './utils/dom.js'

export { useMediaQuery, useBreakpointUp } from './hooks/useMediaQuery.js'
export { useReducedMotion } from './hooks/useReducedMotion.js'
export { useFocusTrap } from './hooks/useFocusTrap.js'
export { useSwipe } from './hooks/useSwipe.js'
export type { SwipeHandlers, SwipeAxis } from './hooks/useSwipe.js'
export { useFlip } from './hooks/useFlip.js'
export { useLongPress } from './hooks/useLongPress.js'
export type { LongPressOptions } from './hooks/useLongPress.js'
export { useHaptic } from './hooks/useHaptic.js'
export type { HapticKind } from './hooks/useHaptic.js'
export { useVisualViewport } from './hooks/useVisualViewport.js'

export { Button } from './components/Button/Button.js'
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/Button/Button.js'
export { IconButton } from './components/IconButton/IconButton.js'
export type { IconButtonProps } from './components/IconButton/IconButton.js'
export { Field } from './components/Field/Field.js'
export type { FieldProps } from './components/Field/Field.js'
export { Checkbox } from './components/Checkbox/Checkbox.js'
export type { CheckboxProps } from './components/Checkbox/Checkbox.js'
export { ListView } from './components/ListView/ListView.js'
export type { ListViewProps } from './components/ListView/ListView.js'
export { Row } from './components/Row/Row.js'
export type { RowProps, SwipeAction } from './components/Row/Row.js'
export { Card } from './components/Card/Card.js'
export type { CardProps } from './components/Card/Card.js'
export { Overlay } from './components/Overlay/Overlay.js'
export type {
  OverlayProps,
  OverlayCloseReason,
  Presentation,
} from './components/Overlay/Overlay.js'
export { ToastViewport, toast, subscribeToasts, getToasts } from './components/Toast/Toast.js'
export type { ToastApi, ToastOptions, ToastRecord, ToastViewportProps } from './components/Toast/Toast.js'
export { EmptyState } from './components/EmptyState/EmptyState.js'
export type { EmptyStateProps } from './components/EmptyState/EmptyState.js'
export { Skeleton } from './components/Skeleton/Skeleton.js'
export type { SkeletonProps } from './components/Skeleton/Skeleton.js'
export { Menu } from './components/Menu/Menu.js'
export type { MenuProps, MenuItem, MenuEntry } from './components/Menu/Menu.js'
export { Tabs } from './components/Tabs/Tabs.js'
export type { TabsProps, TabItem } from './components/Tabs/Tabs.js'
export { Avatar } from './components/Avatar/Avatar.js'
export type { AvatarProps } from './components/Avatar/Avatar.js'
export { Chip } from './components/Chip/Chip.js'
export type { ChipProps } from './components/Chip/Chip.js'
export { Divider } from './components/Divider/Divider.js'
export type { DividerProps } from './components/Divider/Divider.js'
export { Spinner } from './components/Spinner/Spinner.js'
export type { SpinnerProps } from './components/Spinner/Spinner.js'
