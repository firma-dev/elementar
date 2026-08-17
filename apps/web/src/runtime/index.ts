/** Барель рантайма для двери: тянет тяжёлую часть (крипта, сессия) — грузится лениво. */
export { repo, deviceActor, deviceName, setDeviceName, lastDocOf } from './db.js'
export { installRuntime } from './install.js'
export { createDocument, openDocument, DocOpenError } from './doc.js'
export type { CreateDocOptions, DocHandle, DocOpenReason, OpenDocOptions } from './doc.js'
