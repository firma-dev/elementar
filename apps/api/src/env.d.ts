/**
 * Привязки и переменные Worker'а (§8.12). Числа-дублёры из [vars] существуют только для
 * оперативной подстройки в дашборде; значения по умолчанию берутся из @elementar/proto,
 * объявлять протокольные константы здесь запрещено (§2.3 п.8).
 */
export interface Env {
  DOC: DurableObjectNamespace
  LIMITER: DurableObjectNamespace
  INVITE: DurableObjectNamespace
  DB: D1Database
  SNAPSHOTS: R2Bucket
  CONFIG: KVNamespace

  ELM_ENV: string
  ELM_ALLOWED_ORIGIN: string

  ELM_IP_PEPPER?: string
  ELM_TURNSTILE_SECRET?: string
  ELM_TURNSTILE_SITEKEY?: string
  ELM_ADMIN_TOKEN?: string
}
