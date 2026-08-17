/**
 * @elementar/shell — компоненты, которые знают про документы (§11.9).
 * Зависимости ровно четыре: @elementar/core, @elementar/ui, @elementar/llm, @elementar/proto.
 * Стили: import '@elementar/shell/styles.css' поверх '@elementar/ui/styles.css'.
 */

export { AppShell } from './components/AppShell/AppShell.js'
export type { AppShellProps } from './components/AppShell/AppShell.js'
export { TopBar } from './components/AppShell/TopBar.js'
export type { TopBarProps } from './components/AppShell/TopBar.js'
export { TabBar } from './components/AppShell/TabBar.js'
export type { TabBarProps } from './components/AppShell/TabBar.js'
export { Rail } from './components/AppShell/Rail.js'
export type { RailProps } from './components/AppShell/Rail.js'
export { badgeText } from './components/AppShell/nav.js'
export type { NavItem } from './components/AppShell/nav.js'

export { QrCode } from './components/QrCode/QrCode.js'
export type { QrCodeProps } from './components/QrCode/QrCode.js'
export { QR_ECC, QR_QUIET_MODULES, QR_SIZE_PX, qrMatrix, qrPath, qrSvg } from './qr.js'
export type { QrEcc, QrMatrix, QrSvgOptions } from './qr.js'

export { ShareSheet, ShareButton } from './components/ShareSheet/ShareSheet.js'
export type { ShareSheetProps, ShareButtonProps, ShareMethod } from './components/ShareSheet/ShareSheet.js'
export { LinkSaveSheet } from './components/ShareSheet/LinkSaveSheet.js'
export type { LinkSaveSheetProps, LinkSaveMethod } from './components/ShareSheet/LinkSaveSheet.js'

export { ModelSlotSettings } from './components/ModelSlotSettings/ModelSlotSettings.js'
export type { ModelSlotSettingsProps } from './components/ModelSlotSettings/ModelSlotSettings.js'

export { AgentProposal, AgentProposals } from './components/AgentProposal/AgentProposal.js'
export type { AgentProposalProps, AgentProposalsProps } from './components/AgentProposal/AgentProposal.js'
export { AgentSheet, AgentButton } from './components/AgentProposal/AgentSheet.js'
export type { AgentSheetProps, AgentButtonProps } from './components/AgentProposal/AgentSheet.js'
export {
  acceptArgs,
  acceptLabel,
  changedFields,
  keptIndices,
  kindTitle,
  proposalAuthorLine,
} from './components/AgentProposal/proposal.js'

export { PresenceChip } from './components/PresenceChip/PresenceChip.js'
export type { PresenceChipProps } from './components/PresenceChip/PresenceChip.js'
export { defaultViewLabel, peersOf } from './components/PresenceChip/presence.js'
export type { PeersArgs, PresencePeer } from './components/PresenceChip/presence.js'

export { DigestSheet, digestLine } from './components/DigestSheet/DigestSheet.js'
export type { DigestSheetProps } from './components/DigestSheet/DigestSheet.js'

export { TrashScreen } from './components/TrashScreen/TrashScreen.js'
export type { TrashScreenProps } from './components/TrashScreen/TrashScreen.js'

export { RecoveryScreen } from './components/RecoveryScreen/RecoveryScreen.js'
export type { RecoveryScreenProps } from './components/RecoveryScreen/RecoveryScreen.js'
export { RECOVERY_FILE_ACCEPT, recoveryKind } from './components/RecoveryScreen/recovery.js'
export type { RecoveryKind } from './components/RecoveryScreen/recovery.js'

export { draftedChanges, putDrafts } from './agent.js'
export type { DraftWithOrigin } from './agent.js'

export { canShare, copyText, downloadFile, readFileText, shareLink } from './share.js'
export type { ShareOutcome } from './share.js'
export { CHANGES, DEVICES, TASKS, formatLastSeen, initialOf, plural, withCount } from './text.js'
export { useSignalValue } from './hooks.js'
