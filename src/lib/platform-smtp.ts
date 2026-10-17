/**
 * Platform-wide outgoing mail for the projects this panel creates.
 *
 * Every project is born with the in-stack fake mailer (`supabase-mail`), so no confirmation, invite
 * or recovery mail is ever delivered and a user who signs up can never confirm. The operator has one
 * real SMTP account for the whole platform; setting it once here makes every project use it.
 *
 * Variables (on the panel): PLATFORM_SMTP_HOST, PLATFORM_SMTP_PORT, PLATFORM_SMTP_USER,
 * PLATFORM_SMTP_PASS, PLATFORM_SMTP_FROM (the sender address), PLATFORM_SMTP_SENDER_NAME (optional).
 * All of host/port/user/pass/from are required; a half-set configuration is ignored rather than
 * applied, because a project pointed at a mail server it cannot log in to is worse than the fake
 * one: sign-up would look like it works and the mail would vanish.
 */

/** The value the generator writes for the fake mailer; only a project still on it may be migrated. */
export const FAKE_MAILER_HOST = 'supabase-mail'

export type SmtpEnv = Record<string, string | undefined>

export function platformSmtpEnv(env: SmtpEnv = process.env): Record<string, string> | null {
  const host = env.PLATFORM_SMTP_HOST?.trim()
  const port = env.PLATFORM_SMTP_PORT?.trim()
  const user = env.PLATFORM_SMTP_USER?.trim()
  const pass = env.PLATFORM_SMTP_PASS
  const from = env.PLATFORM_SMTP_FROM?.trim()
  if (!host || !port || !user || !pass || !from) return null
  if (!/^\d{1,5}$/.test(port)) return null
  if (!/^[^\s@]+@[^\s@]+$/.test(from)) return null

  return {
    SMTP_HOST: host,
    SMTP_PORT: port,
    SMTP_USER: user,
    SMTP_PASS: pass,
    SMTP_ADMIN_EMAIL: from,
    SMTP_SENDER_NAME: env.PLATFORM_SMTP_SENDER_NAME?.trim() || 'Supabase',
  }
}

/**
 * What to write into an existing project's `.env` on redeploy: the platform SMTP, but only if the
 * project is still on the fake mailer. A project whose owner set their own SMTP keeps it.
 */
export function smtpMigration(
  currentHost: string | undefined,
  platform: Record<string, string> | null
): Record<string, string> | null {
  if (!platform) return null
  if (currentHost !== undefined && currentHost !== FAKE_MAILER_HOST) return null
  return platform
}
