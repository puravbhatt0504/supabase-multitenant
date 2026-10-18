'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface Line {
  at: string
  severity: 'error' | 'warn' | 'info' | 'debug'
  text: string
}

const COLOR: Record<Line['severity'], string> = {
  error: 'text-red-400',
  warn: 'text-amber-300',
  info: 'text-foreground',
  debug: 'text-muted-foreground',
}

/** Logs of one service at a time; "Follow" polls for lines newer than the last one shown. */
export function ProjectLogs({ projectId }: { projectId: string }) {
  const [services, setServices] = useState<string[]>([])
  const [service, setService] = useState('')
  const [severity, setSeverity] = useState('')
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState<string | null>(null)
  const last = useRef('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetch(`/api/projects/${projectId}/logs`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Logs are not available for your role.'))))
      .then((j: { services: string[] }) => {
        setServices(j.services)
        setService((s) => s || j.services.find((n) => n === 'rest') || j.services[0] || '')
      })
      .catch((e: Error) => setError(e.message))
  }, [projectId])

  const load = useCallback(
    async (incremental: boolean) => {
      if (!service) return
      const p = new URLSearchParams({ service, tail: '300' })
      if (severity) p.set('severity', severity)
      if (query) p.set('q', query)
      if (incremental && last.current) p.set('since', last.current)
      const res = await fetch(`/api/projects/${projectId}/logs?${p}`)
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not read logs')
        return
      }
      setError(null)
      const fresh: Line[] = json.lines
      if (incremental) {
        // `since` is inclusive: drop the line we already have.
        const seen = new Set<string>()
        setLines((old) => {
          old.slice(-50).forEach((l) => seen.add(`${l.at}|${l.text}`))
          const add = fresh.filter((l) => !seen.has(`${l.at}|${l.text}`))
          return add.length ? [...old, ...add].slice(-1000) : old
        })
      } else {
        setLines(fresh)
      }
      const tail = fresh[fresh.length - 1]
      if (tail?.at) last.current = tail.at
    },
    [projectId, service, severity, query]
  )

  useEffect(() => {
    last.current = ''
    void load(false)
  }, [load])

  useEffect(() => {
    if (!follow) return
    const t = setInterval(() => void load(true), 3000)
    return () => clearInterval(t)
  }, [follow, load])

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines, follow])

  const field = 'rounded-md border border-border bg-background px-2 py-1 text-sm'
  return (
    <section className="mt-6 rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-4">
        <h2 className="mr-auto text-sm font-semibold uppercase tracking-wide text-muted-foreground">Logs</h2>
        <select className={field} value={service} onChange={(e) => setService(e.target.value)} aria-label="Service">
          {services.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select className={field} value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Minimum severity">
          <option value="">all levels</option>
          <option value="warn">warnings +</option>
          <option value="error">errors</option>
        </select>
        <input className={field} placeholder="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <button onClick={() => void load(false)} className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent">
          Refresh
        </button>
      </header>
      {error && <p className="px-5 py-3 text-sm text-red-400">{error}</p>}
      <div ref={box} className="max-h-96 overflow-auto px-5 py-3 font-mono text-xs leading-5">
        {lines.length === 0 && !error ? (
          <p className="text-muted-foreground">No lines.</p>
        ) : (
          lines.map((l, i) => (
            <div key={`${l.at}-${i}`} className={`whitespace-pre-wrap break-all ${COLOR[l.severity]}`}>
              <span className="text-muted-foreground">{l.at.slice(11, 19)} </span>
              {l.text}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
