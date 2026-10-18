import { NextResponse } from 'next/server'

import { prisma } from './db'
import { listProjectServices, readServiceLogs, SEVERITIES, type Severity } from './project-logs'

/**
 * Shared by the session and token routes. Without `service` it lists the project's services;
 * with one it returns recent lines (`tail`, `since`, `severity`, `q`). Following a log is a poll
 * with `since` set to the last line's time.
 */
export async function projectLogsResponse(slug: string, params: URLSearchParams) {
  const others = (await prisma.project.findMany({ select: { slug: true } })).map((p) => p.slug)
  const services = await listProjectServices(slug, others)

  const service = params.get('service')
  if (!service) return NextResponse.json({ services })
  if (!services.includes(service)) {
    return NextResponse.json({ error: `No such service. Available: ${services.join(', ') || 'none running'}` }, { status: 404 })
  }

  const severity = params.get('severity')
  if (severity && !SEVERITIES.includes(severity as Severity)) {
    return NextResponse.json({ error: `severity must be one of ${SEVERITIES.join(', ')}` }, { status: 400 })
  }

  try {
    const lines = await readServiceLogs(slug, service, {
      tail: Number(params.get('tail') ?? 200) || 200,
      since: params.get('since') ?? undefined,
      minSeverity: (severity as Severity | null) ?? undefined,
      search: params.get('q') ?? undefined,
    })
    return NextResponse.json({ service, lines })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not read logs' }, { status: 500 })
  }
}
