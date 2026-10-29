import { describe, expect, onTestFinished, test } from 'vitest'
import type { Plugin } from '../../plugin'
import { createServer } from '../index'
import { getModuleTypeFromId } from '../transformRequest'

describe('getModuleTypeFromId', () => {
  const testCases = [
    { id: 'foo.js', expected: 'js' },
    { id: 'foo.ts', expected: 'ts' },
    { id: 'foo.a.js', expected: 'js' },
    { id: '', expected: undefined },
  ]

  for (const { id, expected } of testCases) {
    test(`should return ${expected} for id: ${id}`, () => {
      const result = getModuleTypeFromId(id)
      expect(result).toBe(expected)
    })
  }
})

test('reloadModule during an in-flight transform does not serve or cache the old result', async () => {
  const virtualId = '\0virtual:state'
  const url = 'virtual:state'
  let version = 'v0'
  let holdTransform = false
  let releaseTransform!: () => void
  const transformGate = new Promise<void>((r) => (releaseTransform = r))
  let onTransformStart: (() => void) | undefined

  const plugin: Plugin = {
    name: 'state-module',
    resolveId(id) {
      if (id === 'virtual:state') return virtualId
    },
    load(id) {
      if (id === virtualId) return `export const version = "${version}"\n`
    },
    async transform(_code, id) {
      if (id === virtualId && holdTransform) {
        onTransformStart?.()
        await transformGate
      }
    },
  }

  const server = await createServer({
    configFile: false,
    root: import.meta.dirname,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false },
    plugins: [plugin],
  })
  onTestFinished(() => server.close())
  const environment = server.environments.client

  await environment.transformRequest(url)
  const mod = environment.moduleGraph.getModuleById(virtualId)!
  expect(mod.file).toBeTruthy()

  // reload with v1 and hold its transform inside the transform hook
  version = 'v1'
  await environment.reloadModule(mod)
  holdTransform = true
  const transformStarted = new Promise<void>(
    (resolve) => (onTransformStart = resolve),
  )
  const staleRequest = environment.transformRequest(url)
  await transformStarted

  // the state changes while the v1 transform is still running
  version = 'v2'
  await environment.reloadModule(mod)
  const freshRequest = environment.transformRequest(url)

  releaseTransform()
  await staleRequest.catch(() => {})
  expect((await freshRequest)?.code).toContain('"v2"')
  expect(mod.transformResult?.code).toContain('"v2"')
})
