'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Provider {
  id: string
  label: string
  consoleUrl: string
  enabled: boolean
  clientId: string
  hasSecret: boolean
  callbackUrl: string
}

/**
 * Sign in with Google / GitHub / ... for this project's end users.
 *
 * The account owner registers an OAuth app in the provider's console (the panel cannot do that for
 * them), copies the callback URL shown here into it, and pastes the client ID and secret back. The
 * secret is write-only: once saved the panel shows that one exists, not what it is.
 */
export function AuthProvidersSettings({ projectId }: { projectId: string }) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const response = await fetch(`/api/projects/${projectId}/auth/providers`)
        if (!response.ok) {
          setError(
            response.status === 403
              ? 'You do not have permission to view this project’s sign-in providers.'
              : `Could not load providers (${response.status})`
          )
          return
        }
        const data = await response.json()
        if (!cancelled) setProviders(data.providers ?? [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load providers')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [projectId])

  function edit(provider: Provider) {
    setOpenId(provider.id === openId ? null : provider.id)
    setClientId(provider.clientId)
    setSecret('')
    setError('')
    setSaved('')
  }

  async function submit(provider: Provider, enabled: boolean) {
    setBusy(true)
    setError('')
    setSaved('')
    try {
      const response = await fetch(`/api/projects/${projectId}/auth/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider.id, enabled, clientId, secret }),
      })
      const data = await response.json()
      if (!response.ok) {
        setError(data.error ?? `Could not save (${response.status})`)
        return
      }
      setProviders(data.providers ?? [])
      setSecret('')
      setSaved(
        enabled
          ? `${provider.label} sign-in is on. The auth service was restarted.`
          : `${provider.label} sign-in is off.`
      )
      if (!enabled) setOpenId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>🔑 Sign-in providers</CardTitle>
        <CardDescription>
          Let this project’s users sign in with Google, GitHub and others. Register an OAuth app with
          the provider, use the callback URL shown below, then paste the client ID and secret here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-500 px-3 py-2 rounded text-sm">
            {error}
          </div>
        )}
        {saved && (
          <div className="bg-green-500/10 border border-green-500/20 text-green-500 px-3 py-2 rounded text-sm">
            {saved}
          </div>
        )}

        {providers.map((provider) => (
          <div key={provider.id} className="border rounded-md">
            <button
              type="button"
              className="w-full flex items-center justify-between px-3 py-2 text-left"
              onClick={() => edit(provider)}
            >
              <span className="font-medium">{provider.label}</span>
              <span className={provider.enabled ? 'text-green-500 text-sm' : 'text-muted-foreground text-sm'}>
                {provider.enabled ? 'On' : provider.hasSecret ? 'Off (credentials saved)' : 'Off'}
              </span>
            </button>

            {openId === provider.id && (
              <div className="px-3 pb-3 space-y-3 border-t pt-3">
                <div>
                  <Label>Callback URL to register with {provider.label}</Label>
                  <Input readOnly value={provider.callbackUrl} onFocus={(event) => event.target.select()} />
                  <p className="text-xs text-muted-foreground mt-1">
                    Create the app at{' '}
                    <a className="underline" href={provider.consoleUrl} target="_blank" rel="noreferrer">
                      {provider.consoleUrl}
                    </a>
                    .
                  </p>
                </div>
                <div>
                  <Label htmlFor={`${provider.id}_client_id`}>Client ID</Label>
                  <Input
                    id={`${provider.id}_client_id`}
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <Label htmlFor={`${provider.id}_secret`}>Client secret</Label>
                  <Input
                    id={`${provider.id}_secret`}
                    type="password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder={provider.hasSecret ? '•••••••• (saved — leave blank to keep)' : 'paste the secret'}
                    autoComplete="off"
                  />
                </div>
                <div className="flex gap-3">
                  <Button onClick={() => submit(provider, true)} disabled={busy}>
                    {busy ? 'Saving…' : provider.enabled ? 'Save changes' : 'Turn on'}
                  </Button>
                  {provider.enabled && (
                    <Button variant="outline" onClick={() => submit(provider, false)} disabled={busy}>
                      Turn off
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
