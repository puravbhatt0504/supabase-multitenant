import { describe, expect, it } from 'vitest'

import { platformSmtpEnv, smtpMigration } from '../src/lib/platform-smtp'

const full = {
  PLATFORM_SMTP_HOST: 'smtp.example.com',
  PLATFORM_SMTP_PORT: '587',
  PLATFORM_SMTP_USER: 'apikey',
  PLATFORM_SMTP_PASS: 's3cret',
  PLATFORM_SMTP_FROM: 'no-reply@example.com',
}

describe('platformSmtpEnv', () => {
  it('maps a complete configuration onto the variables the auth service reads', () => {
    expect(platformSmtpEnv(full)).toEqual({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'apikey',
      SMTP_PASS: 's3cret',
      SMTP_ADMIN_EMAIL: 'no-reply@example.com',
      SMTP_SENDER_NAME: 'Supabase',
    })
  })

  it('is off when nothing is set', () => {
    expect(platformSmtpEnv({})).toBeNull()
  })

  it.each(['PLATFORM_SMTP_HOST', 'PLATFORM_SMTP_PORT', 'PLATFORM_SMTP_USER', 'PLATFORM_SMTP_PASS', 'PLATFORM_SMTP_FROM'])(
    'ignores a half-set configuration (missing %s) instead of applying it',
    (missing) => {
      expect(platformSmtpEnv({ ...full, [missing]: '' })).toBeNull()
    }
  )

  it('rejects a port or sender that is not what it claims to be', () => {
    expect(platformSmtpEnv({ ...full, PLATFORM_SMTP_PORT: 'abc' })).toBeNull()
    expect(platformSmtpEnv({ ...full, PLATFORM_SMTP_FROM: 'not-an-address' })).toBeNull()
  })
})

describe('smtpMigration', () => {
  const platform = platformSmtpEnv(full)

  it('moves a project off the fake mailer', () => {
    expect(smtpMigration('supabase-mail', platform)).toEqual(platform)
  })

  it('leaves a project that chose its own mail server alone', () => {
    expect(smtpMigration('smtp.theirs.com', platform)).toBeNull()
  })

  it('does nothing when the platform has no SMTP', () => {
    expect(smtpMigration('supabase-mail', null)).toBeNull()
  })
})
