import { describe, expect, it } from 'vitest'

import {
  GATEWAY_CONTAINER,
  gatewayConnectCommand,
  gatewayDisconnectCommand,
  tenantNetwork,
  tenantNetworkAlias,
} from '../src/lib/tenant-gateway-apply'

const SLUG = 'birth-check-1791919976310'

/**
 * `docker network connect|disconnect [OPTIONS] NETWORK CONTAINER`.
 *
 * This order was got wrong once and the failure looks like something else entirely:
 * docker reports "No such container: <slug>_default" (it read the network name as the
 * container), and the tenant never reaches the gateway. These assertions exist so the
 * order cannot drift again.
 */
describe('network join commands', () => {
  it('puts the network before the container when connecting', () => {
    const command = gatewayConnectCommand(SLUG)
    expect(command.startsWith('docker network connect')).toBe(true)
    expect(command).toContain(`--alias ${SLUG}-gw`)
    expect(command.indexOf(tenantNetwork(SLUG))).toBeLessThan(command.indexOf(GATEWAY_CONTAINER))
  })

  it('puts the network before the container when disconnecting', () => {
    const command = gatewayDisconnectCommand(SLUG)
    expect(command.startsWith('docker network disconnect')).toBe(true)
    expect(command.indexOf(tenantNetwork(SLUG))).toBeLessThan(command.indexOf(GATEWAY_CONTAINER))
  })

  it('names the network the way compose does', () => {
    expect(tenantNetwork(SLUG)).toBe(`${SLUG}_default`)
    expect(tenantNetworkAlias(SLUG, 'gw')).toBe(`${SLUG}-gw`)
  })
})
