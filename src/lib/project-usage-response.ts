import { NextResponse } from 'next/server'

import { prisma } from './db'
import { measureProjectUsage } from './project-usage'

export async function projectUsageResponse(slug: string) {
  const others = (await prisma.project.findMany({ select: { slug: true } })).map((p) => p.slug)
  const usage = await measureProjectUsage(slug, others)
  return NextResponse.json({ usage: { ...usage, measuredAt: new Date().toISOString() } })
}
