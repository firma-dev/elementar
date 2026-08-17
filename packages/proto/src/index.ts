/**
 * @elementar/proto — общий код клиента и сервера: константы протокола, коды ошибок,
 * кодек кадров, канонизация подписи, типы REST и WS. Ни клиент, ни apps/api не имеют
 * права объявлять что-либо из этого локально (§2.3 п.8, §2.4).
 */
export * from './env.js'
export * from './consts.js'
export * from './codes.js'
export * from './keys.js'
export * from './canon.js'
export * from './frames.js'
export * from './http.js'
export * from './ws.js'
