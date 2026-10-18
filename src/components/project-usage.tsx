'use client'

import { useEffect, useState } from 'react'

interface Usage {
  databaseBytes: number | null
  connections: number | null
  endUsers: number | null
  activeUsers30d: number | null
  storageBytes: number | null
  memoryBytes: number
  containers: { name: string; memoryBytes: number; cpuPercent: number }[]
}

function bytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/** Measured usage of one project: database, users, storage and what its containers cost. */
export function ProjectUsage({ projectId }: { projectId: string }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetch(`/api/projects/${projectId}/usage`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Usage is not available.'))))
      .then((j: { usage: Usage }) => !cancelled && setUsage(j.usage))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => { cancelled = true }
  }, [projectId])

  const cell = (label: string, value: string) => (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
    </div>
  )

  return (
    <section className="mt-6 rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Usage</h2>
      </header>
      {error ? (
        <p className="px-5 py-4 text-sm text-red-400">{error}</p>
      ) : !usage ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">Measuring…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
          {cell('Database', bytes(usage.databaseBytes))}
          {cell('Connections', usage.connections?.toString() ?? '—')}
          {cell('End users', usage.endUsers?.toString() ?? '—')}
          {cell('Active, 30 days', usage.activeUsers30d?.toString() ?? '—')}
          {cell('File storage', bytes(usage.storageBytes))}
          {cell(`Memory · ${usage.containers.length} containers`, bytes(usage.memoryBytes))}
        </div>
      )}
    </section>
  )
}
